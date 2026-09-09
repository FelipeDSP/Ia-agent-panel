#!/usr/bin/env node
/**
 * Monta o `agente-principal.json` COM o portao de venda afirmada.
 *
 * NAO IMPORTA NADA. Escreve o arquivo do repositorio; levar para a instancia e
 * passo manual e separado.
 *
 * ---------------------------------------------------------------------------
 * O PONTO QUE FAZ O TRABALHO EXISTIR OU NAO
 * ---------------------------------------------------------------------------
 * `Envia Mensagem Chatwoot` e `Registra Mensagem` NAO leem o no anterior: os
 * dois puxam `$('Estima Tokens')...` POR NOME. Inserir um no no meio da cadeia
 * nao intercepta coisa nenhuma — a mensagem sai como o modelo escreveu e o
 * portao vira decoracao.
 *
 * SAO TRES REFERENCIAS, E NAO DUAS. O enunciado deste trabalho lista duas
 * (`body` e o 3o elemento do `queryReplacement`); a terceira e o 10o elemento,
 * `componentes_json`. Ela precisa mudar pelo MESMO motivo das outras: e por ela
 * que o veredito do portao chega ao banco. Se ficar apontando para o
 * `Estima Tokens`, o portao funciona, o cliente recebe o texto certo e **o
 * registro do veredito nunca acontece** — a metade que a
 * docs/VAZAMENTO-USED-TOOLS.md ensina a nao perder, perdida em silencio.
 *
 * Este script troca as tres e CONFERE as tres depois, abortando se alguma
 * ficou para tras.
 * ---------------------------------------------------------------------------
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARQ = path.join(RAIZ, 'n8n', 'workflows', 'agente-principal.json');
const FONTE_PORTAO = path.join(RAIZ, 'n8n', 'aplica-portao.js');

const original = fs.readFileSync(ARQ, 'utf8');
const w = JSON.parse(original);

// O FIM DE LINHA E DETECTADO, NAO CRAVADO — e a primeira versao cravava CRLF.
//
// Serializar com o fim de linha errado reescreveria os ~2800 fins de linha do
// arquivo e afogaria a revisao num diff de arquivo inteiro. Mas cravar CRLF
// tambem nao serve: o `gerar-principal.mjs` grava com `JSON.stringify(...) +
// '\n'`, ou seja LF, e o git deste projeto ainda converte na working copy
// (`core.autocrlf=true`, sem `.gitattributes` — ver AMBIENTE-WINDOWS.md). O
// arquivo oscila, e a guarda abaixo derrubou este script assim que o gerador
// rodou depois dele.
//
// Detectar e o que faz os dois conviverem em qualquer ordem.
const CRLF = original.includes('\r\n');
const serializar = (obj) => {
  const txt = JSON.stringify(obj, null, 2) + '\n';
  return CRLF ? txt.replace(/\n/g, '\r\n') : txt;
};
if (serializar(w) !== original) {
  throw new Error('round-trip nao devolve o arquivo byte a byte — abortando antes de tocar em nada');
}

const no = (nome) => {
  const n = w.nodes.find((x) => x.name === nome);
  if (!n) throw new Error(`no ausente: ${nome}`);
  return n;
};
const id = (s) => s.padEnd(36, '0').slice(0, 36);

// Idempotencia: remove a versao da rodada anterior antes de recriar.
const NOVOS = ['Estado do Pedido', 'Aplica Portao', 'Portao Transferiu?', 'Nota Privada (portao)'];
w.nodes = w.nodes.filter((n) => !NOVOS.includes(n.name));
for (const n of NOVOS) delete w.connections[n];

const posEstima = no('Estima Tokens').position;

// ---------------------------------------------------------------------------
// 1. Estado do Pedido — a leitura, `stable`, sem expiracao (migracao 56)
// ---------------------------------------------------------------------------
// `p_perfil` vem do `Tools Ativas`, que roda no caminho unico e SEMPRE executa.
// Nada de IF de topologia: dois ramos fariam os consumidores referenciarem um
// no que nao executa no perfil basico, que e a classe de falha que este
// trabalho existe para evitar. A economia mora dentro da funcao.
w.nodes.push({
  parameters: {
    operation: 'executeQuery',
    query: 'SELECT tem_rascunho, pedido_id, total_centavos, itens, escreveu_neste_turno, barrou_anterior\n'
      + '  FROM public.api_n8n_estado_pedido($1::uuid, $2::bigint, $3::text);',
    options: {
      queryReplacement: "={{ [ $('Resolve Tenant').first().json.tenant_id, "
        + "$('Extrair e Filtrar').first().json.conversation_id, "
        + "$('Tools Ativas').first().json.perfil ] }}",
    },
  },
  type: 'n8n-nodes-base.postgres',
  typeVersion: 2.6,
  position: [posEstima[0] + 180, posEstima[1]],
  name: 'Estado do Pedido',
  id: id('portao-estado'),
  credentials: no('Credencial (resposta)').credentials,
});

// ---------------------------------------------------------------------------
// 2. Aplica Portao — a decisao
// ---------------------------------------------------------------------------
const corpo = fs.readFileSync(FONTE_PORTAO, 'utf8');
if (!/REGRA 1 \(modalidade C\)/.test(corpo)) {
  throw new Error('n8n/aplica-portao.js nao parece o arquivo esperado — abortando');
}
w.nodes.push({
  parameters: { jsCode: corpo },
  type: 'n8n-nodes-base.code',
  typeVersion: 2,
  position: [posEstima[0] + 360, posEstima[1]],
  name: 'Aplica Portao',
  id: id('portao-aplica'),
});

// ---------------------------------------------------------------------------
// 3. A cadeia
// ---------------------------------------------------------------------------
w.connections['Estima Tokens'] = { main: [[{ node: 'Estado do Pedido', type: 'main', index: 0 }]] };
w.connections['Estado do Pedido'] = { main: [[{ node: 'Aplica Portao', type: 'main', index: 0 }]] };
w.connections['Aplica Portao'] = { main: [[{ node: 'Credencial (resposta)', type: 'main', index: 0 }]] };

// ---------------------------------------------------------------------------
// 4. AS TRES REFERENCIAS POR NOME
// ---------------------------------------------------------------------------
const envia = no('Envia Mensagem Chatwoot');
envia.parameters.body = envia.parameters.body.split("$('Estima Tokens')").join("$('Aplica Portao')");

const registra = no('Registra Mensagem');
const qr = registra.parameters.options.queryReplacement;
// So `output` (3o) e `componentes_json` (10o) vem do portao. `tokens_entrada` e
// `tokens_saida` seguem do `Estima Tokens`: eles medem o que a OpenAI cobrou
// pelo texto que o MODELO gerou, e o portao nao muda isso. Trocar tambem esses
// faria o rateio contar o texto substituto, que ninguem gerou por token.
registra.parameters.options.queryReplacement = qr
  .split("$('Estima Tokens').first().json.output")
  .join("$('Aplica Portao').first().json.output")
  .split("$('Estima Tokens').first().json.componentes_json")
  .join("$('Aplica Portao').first().json.componentes_json");

// ---------------------------------------------------------------------------
// 5. Transferencia depois de duas barradas seguidas — SO a nota privada
// ---------------------------------------------------------------------------
// A nota entra DEPOIS do `Registra Mensagem`: o cliente ja recebeu a substituta
// e a linha do log ja existe quando o humano e chamado.
//
// NAO PAUSA A CONVERSA, e a razao e de dado, nao de escopo: a unica funcao que
// pausa hoje e `api_n8n_definir_status_conversa`, e ela crava
// `motivo_pausa = 'mensagem_humana'` (migracao 47). Usa-la aqui gravaria um
// motivo FALSO — diria que um humano falou quando quem interveio foi o portao —
// e `motivo_pausa` existe exatamente para distinguir isso. Pausar de verdade
// pede um motivo novo, que e migracao propria. Fica registrado como aberto.
w.nodes.push({
  parameters: {
    conditions: {
      options: { caseSensitive: true, typeValidation: 'strict', version: 2 },
      conditions: [{
        id: 'portao-transf',
        leftValue: "={{ $('Aplica Portao').first().json._portao_transferir }}",
        rightValue: true,
        operator: { type: 'boolean', operation: 'true', singleValue: true },
      }],
      combinator: 'and',
    },
    options: {},
  },
  type: 'n8n-nodes-base.if',
  typeVersion: 2.2,
  position: [posEstima[0] + 900, posEstima[1] + 200],
  name: 'Portao Transferiu?',
  id: id('portao-transf-if'),
});

w.nodes.push({
  parameters: {
    method: 'POST',
    url: "={{ $('Credencial (resposta)').first().json.chatwoot_url }}/api/v1/accounts/"
      + "{{ $('Extrair e Filtrar').first().json.chatwoot_account_id }}/conversations/"
      + "{{ $('Extrair e Filtrar').first().json.conversation_id }}/messages",
    sendHeaders: true,
    headerParameters: {
      parameters: [
        { name: 'api_access_token', value: "={{ $('Credencial (resposta)').first().json.chatwoot_token }}" },
        { name: 'Content-Type', value: 'application/json' },
      ],
    },
    sendBody: true,
    contentType: 'raw',
    rawContentType: 'application/json',
    // `private: true` — nota interna, o cliente nao ve.
    body: "={{ JSON.stringify({ content: $('Aplica Portao').first().json._portao_nota_privada,"
      + " message_type: 'outgoing', private: true }) }}",
    options: {},
  },
  type: 'n8n-nodes-base.httpRequest',
  typeVersion: 4.2,
  position: [posEstima[0] + 1080, posEstima[1] + 200],
  name: 'Nota Privada (portao)',
  id: id('portao-nota'),
});

w.connections['Registra Mensagem'] = { main: [[{ node: 'Portao Transferiu?', type: 'main', index: 0 }]] };
w.connections['Portao Transferiu?'] = { main: [[{ node: 'Nota Privada (portao)', type: 'main', index: 0 }], []] };

// ---------------------------------------------------------------------------
// 6. CONFERE — as tres referencias, e a cadeia
// ---------------------------------------------------------------------------
const problemas = [];
const b = no('Envia Mensagem Chatwoot').parameters.body;
if (!b.includes("$('Aplica Portao').first().json.output")) problemas.push('Envia Mensagem Chatwoot.body nao aponta para o portao');
if (b.includes("$('Estima Tokens')")) problemas.push('Envia Mensagem Chatwoot.body ainda referencia Estima Tokens');

const q = no('Registra Mensagem').parameters.options.queryReplacement;
if (!q.includes("$('Aplica Portao').first().json.output")) problemas.push('Registra Mensagem: 3o elemento (output) nao aponta para o portao');
if (!q.includes("$('Aplica Portao').first().json.componentes_json")) problemas.push('Registra Mensagem: 10o elemento (componentes_json) nao aponta para o portao');
if (!q.includes("$('Estima Tokens').first().json.tokens_entrada")) problemas.push('Registra Mensagem: tokens_entrada deveria seguir vindo do Estima Tokens');

// a ordem dos elementos nao pode ter mudado: $3 e output, $10 e componentes
const elems = q.replace(/^=\{\{\s*\[/, '').replace(/\]\s*\}\}$/, '').split(',').map((s) => s.trim());
if (elems.length !== 10) problemas.push(`Registra Mensagem: queryReplacement tem ${elems.length} elementos, esperava 10`);
if (!/output$/.test(elems[2] || '')) problemas.push('Registra Mensagem: o 3o elemento nao e `output`');
if (!/componentes_json$/.test(elems[9] || '')) problemas.push('Registra Mensagem: o 10o elemento nao e `componentes_json`');

const cad = ['Estima Tokens', 'Estado do Pedido', 'Aplica Portao'];
for (let i = 0; i < cad.length - 1; i++) {
  const destino = w.connections[cad[i]]?.main?.[0]?.[0]?.node;
  if (destino !== cad[i + 1]) problemas.push(`cadeia quebrada: ${cad[i]} -> ${destino}, esperava ${cad[i + 1]}`);
}
if (w.connections['Aplica Portao'].main[0][0].node !== 'Credencial (resposta)') {
  problemas.push('Aplica Portao nao volta para Credencial (resposta)');
}

if (problemas.length) {
  console.error('\n  ABORTADO, nada escrito:');
  for (const p of problemas) console.error('   - ' + p);
  process.exit(1);
}

const saida = serializar(w);
fs.writeFileSync(ARQ, saida);
console.log('  nos: +4 (Estado do Pedido, Aplica Portao, Portao Transferiu?, Nota Privada)');
console.log('  referencias por nome trocadas: 3 de 3 (body, output, componentes_json)');
console.log(`  bytes: ${original.length} -> ${saida.length}`);
console.log('\n  NAO IMPORTADO. Leve o arquivo para a instancia manualmente.');
