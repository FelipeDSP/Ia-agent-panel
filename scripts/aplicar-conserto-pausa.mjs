#!/usr/bin/env node
/**
 * Aplica o conserto da pausa automática SOBRE UM EXPORT DA INSTÂNCIA.
 *
 * POR QUE UM SCRIPT, e não um JSON editado à mão. O JSON de import tem de sair
 * do EXPORT, não do repositório: o `Estima Tokens` do repo está 30 linhas à
 * frente da instância (correção de comentário de 18/08 que nunca foi importada),
 * e gerar do repo faria a importação mudar DUAS coisas em vez de uma —
 * impossível de reverter em separado. Este script parte do export, muda só o
 * roteamento da pausa, e diz em voz alta se alguma pré-condição não bater.
 *
 * O QUE ELE MUDA — e nada além disto:
 *
 *  1. `Roteia Evento`, saída `humano`: remove a `ev7` (`private = false`), que é
 *     exatamente a condição que matava o caso que o ramo existe para pegar (o
 *     WAHA registra mensagem do celular do dono como NOTA PRIVADA). A `ev3` da
 *     saída `cliente` FICA.
 *  2. `Roteia Evento`, `ev6`: passa a ler `sender?.type ?? ''` e ganha a `ev8`
 *     (`sender.type` não vazio). Ver "O CAMINHO SEM SENDER" abaixo.
 *  3. `E Humano ou Dispositivo?` -> `Fala com o Cliente?`, com a condição nova
 *     (`private = false` OU marcador do WhatsApp OU marcador do Instagram).
 *  4. A saída FALSA do IF ganha destino: `Nota Interna (ignora)` (NoOp).
 *  5. `notes` nos três nós.
 *  6. Repõe os três parâmetros que o export omitiu por baterem com o default
 *     (`tail`, `maxItems`, `outputPropertyName`) — os mesmos que o
 *     `n8n-validar.mjs` barra. Comportamento idêntico; a diferença é não
 *     depender de o n8n manter o default.
 *
 * O CAMINHO SEM SENDER — desvio consciente do pedido, e a razão.
 *
 * Foi pedido "mantém ev4, ev5 e ev6" e "prevê `message_created` sem `sender`".
 * As duas coisas não cabem na mesma `ev6`: `{{ $json.body.sender.type }}` com
 * `sender` ausente ESTOURA a expressão antes de qualquer operador rodar. Então
 * a `ev6` ganhou `?.` e existe uma `ev8` que exige `sender.type` preenchido.
 *
 * O efeito é o lado seguro: payload sem `sender` NÃO entra no ramo de pausa.
 * Sem identidade não dá para saber se é o próprio bot, e pausar por engano
 * deixa o bot mudo (falha silenciosa) enquanto não pausar faz a IA falar por
 * cima (falha que o dono relata na hora). É a mesma escolha registrada em
 * `docs/PAUSA-AUTOMATICA.md`.
 *
 * Uso:
 *   node scripts/aplicar-conserto-pausa.mjs --export <arquivo.json> [--saida <arquivo.json>]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = fileURLToPath(new URL('../', import.meta.url));

const arg = (nome) => {
  const i = process.argv.indexOf(nome);
  return i === -1 ? undefined : process.argv[i + 1];
};

const ENTRADA = arg('--export');
const SAIDA = arg('--saida') || path.join(RAIZ, 'n8n', 'importar', 'agente-principal-pausa.json');

if (!ENTRADA) {
  console.error('uso: node scripts/aplicar-conserto-pausa.mjs --export <arquivo.json> [--saida <arquivo.json>]');
  process.exit(2);
}

const NOME_ANTIGO = 'E Humano ou Dispositivo?';
const NOME_NOVO = 'Fala com o Cliente?';
const NOME_NOOP = 'Nota Interna (ignora)';

// uuid fixo, e nao sorteado: rodar o script duas vezes sobre o mesmo export tem
// de dar o mesmo arquivo, senao o diff do proximo export vira ruido.
const ID_NOOP = 'b7c1f0d2-4a55-4b9e-9c3a-2f6e8d10a4c7';

const NOTA_ROTEIA = [
  'A ev6 (sender.type != agent_bot) e o UNICO guarda-corpo contra o bot se pausar sozinho.',
  'Ela NAO e protecao independente: a Tool - Transferir para Humano escreve com o MESMO',
  'token de tenant_credenciais que o Envia Mensagem Chatwoot, entao ela e o bot caem ou',
  'passam juntos. Medido em 2026-08-20: os tokens de emporio (59) e estudyou-sendbox (8)',
  'sao de Agent Bot (401 "not authorized for bots" em /profile, /teams e /agents). Token de',
  'tenant NOVO nao e medido por ninguem — se vier um que nao seja de bot, os SETE produtores',
  'de outgoing (5 no principal + a foto + a nota da transferencia) se auto-pausam.',
  '',
  'A ev7 (private = false) foi REMOVIDA: o WAHA registra mensagem do celular do dono como',
  'nota privada, e a ev7 excluia exatamente o caso que este ramo existe para pegar.',
  '',
  'A ev8 existe para o payload sem sender: sender?.type ?? "" evita o estouro da expressao,',
  'e exigir nao-vazio faz esse payload NAO pausar. Sem identidade nao da para distinguir o',
  'proprio bot, e pausar por engano e a falha silenciosa.',
].join('\n');

const NOTA_IF = [
  'Dois marcadores, nao um: "Enviado do WhatsApp" E "Enviado do Instagram", caseSensitive false.',
  'A ponte de Instagram produz a mesma forma que a do WhatsApp.',
  '',
  'A saida FALSA tem destino (Nota Interna (ignora)) DE PROPOSITO: a versao anterior deste no',
  'nao tinha, e por isso nenhuma mensagem digitada dentro do Chatwoot pausou o bot durante',
  'meses — a execucao ficava verde e parava aqui. Saida solta aqui e o modo de falha conhecido.',
  '',
  'A Nota Privada da Tool - Transferir para Humano ("Resumo do atendimento via bot:") passa a',
  'ENTRAR neste ramo depois da remocao da ev7. Ela e inofensiva porque nao tem marcador e cai',
  'no FALSO — a seguranca dela depende inteiramente deste teste dar falso. Se alguem puser um',
  'marcador no texto do resumo, quebra aqui.',
].join('\n');

const NOTA_NOOP = [
  'Nota privada SEM marcador e anotacao interna do atendente: nao e fala com o cliente e nao',
  'pausa o agente. Este no nao faz nada de proposito — ele existe para o ramo ter destino em',
  'vez de morrer em silencio, que foi como o bug original passou meses sem aparecer.',
].join('\n');

const falhar = (msg) => {
  console.error(`\n  ERRO: ${msg}\n`);
  process.exit(1);
};

const wf = JSON.parse(fs.readFileSync(ENTRADA, 'utf8'));
const no = (nome) => wf.nodes.find((n) => n.name === nome);

/* ---------------------------------------------------------------- pre-condicoes */

const roteia = no('Roteia Evento');
const ifNo = no(NOME_ANTIGO);
if (!roteia) falhar('no "Roteia Evento" ausente no export');
if (!ifNo) falhar(`no "${NOME_ANTIGO}" ausente no export — ja consertado?`);
if (no(NOME_NOVO) || no(NOME_NOOP)) falhar('o export JA parece consertado (nome novo ou NoOp presentes)');

const regras = roteia.parameters?.rules?.values ?? [];
const humano = regras.find((r) => r.outputKey === 'humano');
if (!humano) falhar('saida "humano" nao encontrada no Roteia Evento');
if (!humano.conditions.conditions.some((c) => c.id === 'ev7')) {
  falhar('ev7 ausente na saida humano — o export nao e o esperado');
}
const cliente = regras.find((r) => r.outputKey === 'cliente');
if (!cliente?.conditions?.conditions?.some((c) => c.id === 'ev3')) {
  falhar('ev3 ausente na saida cliente — o export nao e o esperado');
}

/* -------------------------------------------------------------------- mudanca 1 */

const antesEv = humano.conditions.conditions.map((c) => c.id).join(',');
humano.conditions.conditions = humano.conditions.conditions.filter((c) => c.id !== 'ev7');

/* -------------------------------------------------------------------- mudanca 2 */

const ev6 = humano.conditions.conditions.find((c) => c.id === 'ev6');
if (!ev6) falhar('ev6 ausente — sem ela o bot se pausa sozinho; abortando');
ev6.leftValue = "={{ $json.body.sender?.type ?? '' }}";

humano.conditions.conditions.push({
  id: 'ev8',
  leftValue: "={{ $json.body.sender?.type ?? '' }}",
  rightValue: '',
  operator: { type: 'string', operation: 'notEmpty', singleValue: true },
});

roteia.notes = NOTA_ROTEIA;
roteia.notesInFlow = false;

/* -------------------------------------------------------------------- mudanca 3 */

ifNo.name = NOME_NOVO;
ifNo.notes = NOTA_IF;
ifNo.notesInFlow = false;
ifNo.parameters = {
  conditions: {
    options: { caseSensitive: false, leftValue: '', typeValidation: 'loose', version: 2 },
    conditions: [
      {
        id: 'h0',
        leftValue: '={{ $json.body.private }}',
        rightValue: false,
        operator: { type: 'boolean', operation: 'false', singleValue: true },
      },
      {
        id: 'h1',
        leftValue: '={{ $json.body.content }}',
        rightValue: 'Enviado do WhatsApp',
        operator: { type: 'string', operation: 'contains' },
      },
      {
        id: 'h2',
        leftValue: '={{ $json.body.content }}',
        rightValue: 'Enviado do Instagram',
        operator: { type: 'string', operation: 'contains' },
      },
    ],
    combinator: 'or',
  },
  looseTypeValidation: true,
  options: {},
};

/* -------------------------------------------------------------------- mudanca 4 */

wf.nodes.push({
  parameters: {},
  type: 'n8n-nodes-base.noOp',
  typeVersion: 1,
  position: [ifNo.position[0] + 224, ifNo.position[1] + 224],
  id: ID_NOOP,
  name: NOME_NOOP,
  notes: NOTA_NOOP,
  notesInFlow: false,
});

// Renomear no n8n NAO e so trocar `name`: a chave de `connections`, todo destino
// que aponte para o nome antigo e toda expressao $('nome') seguem apontando para
// o nome velho e o import quebra em silencio. Por isso a varredura no fim.
if (wf.connections[NOME_ANTIGO]) {
  wf.connections[NOME_NOVO] = wf.connections[NOME_ANTIGO];
  delete wf.connections[NOME_ANTIGO];
}
for (const saidas of Object.values(wf.connections)) {
  for (const ramos of Object.values(saidas)) {
    for (const ramo of ramos || []) {
      for (const c of ramo || []) if (c.node === NOME_ANTIGO) c.node = NOME_NOVO;
    }
  }
}

const mainIf = wf.connections[NOME_NOVO].main;
mainIf[1] = [{ node: NOME_NOOP, type: 'main', index: 0 }];
wf.connections[NOME_NOOP] = { main: [[]] };

/* -------------------------------------------------------------------- mudanca 6 */

const repor = [
  ['Remove Lidos do Acumulo', (p) => { p.tail = false; }],
  ['Volta a Um Item', (p) => { p.maxItems = 1; }],
  ['Baixa Anexo', (p) => {
    p.options ??= {};
    p.options.response ??= {};
    p.options.response.response ??= {};
    p.options.response.response.outputPropertyName = 'data';
  }],
];
for (const [nome, aplicar] of repor) {
  const n = no(nome);
  if (!n) falhar(`no "${nome}" ausente — nao da para repor o parametro omitido pelo export`);
  n.parameters ??= {};
  aplicar(n.parameters);
}

/* ---------------------------------------------------------------- pos-condicoes */

const texto = JSON.stringify(wf);
const problemas = [];
if (texto.includes(NOME_ANTIGO)) problemas.push(`sobrou referencia ao nome antigo "${NOME_ANTIGO}"`);
if (humano.conditions.conditions.some((c) => c.id === 'ev7')) problemas.push('ev7 continua na saida humano');
if (!humano.conditions.conditions.some((c) => c.id === 'ev6')) problemas.push('ev6 sumiu');
if (wf.connections[NOME_NOVO].main.length !== 2) problemas.push('o IF nao ficou com duas saidas');
if (!no(NOME_NOOP)) problemas.push('NoOp nao entrou');
if (wf.nodes.length !== new Set(wf.nodes.map((n) => n.name)).size) problemas.push('nome de no duplicado');
for (const c of Object.values(wf.connections).flatMap((s) => Object.values(s)).flat(2)) {
  if (c && !no(c.node)) problemas.push(`conexao aponta para no inexistente: ${c.node}`);
}
if (problemas.length) falhar(problemas.join('\n         '));

/* --------------------------------------------------------------------- higiene */

// Mesma limpeza do `n8n-limpar-export.mjs`, e pelo mesmo motivo: este arquivo vai
// para o git. `meta.instanceId` identifica a instancia e `versionId`/`pinData`
// so poluem o diff — alem de `pinData` poder conter telefone e nome de contato.
// Fica aqui dentro (e nao num passo separado) para o script ser deterministico:
// rodar duas vezes sobre o mesmo export tem de dar o mesmo arquivo.
for (const campo of ['pinData', 'staticData', 'versionId', 'triggerCount', 'shared', 'tags']) {
  delete wf[campo];
}
if (wf.meta?.instanceId) delete wf.meta.instanceId;

fs.mkdirSync(path.dirname(SAIDA), { recursive: true });
fs.writeFileSync(SAIDA, `${JSON.stringify(wf, null, 2)}\n`);

console.log(`\n== Conserto da pausa aplicado sobre o export ==\n`);
console.log(`  entrada : ${ENTRADA}`);
console.log(`  saida   : ${SAIDA}`);
console.log(`  nos     : ${wf.nodes.length} (era ${wf.nodes.length - 1})`);
console.log(`  humano  : ${antesEv} -> ${humano.conditions.conditions.map((c) => c.id).join(',')}`);
console.log(`  renomeou: "${NOME_ANTIGO}" -> "${NOME_NOVO}"`);
console.log(`  saida falsa do IF -> "${NOME_NOOP}"`);
console.log(`\n  Agora rode:  node scripts/n8n-validar.mjs "${SAIDA}"`);
console.log(`               node tests/pausa-roteamento.mjs\n`);
