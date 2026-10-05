#!/usr/bin/env node
/**
 * teste:tool-pagamento — a ferramenta de gerar link, o webhook, e o que fica
 * entre os dois.
 *
 * ---------------------------------------------------------------------------
 * OS TRÊS CASOS DO ENUNCIADO, E ONDE ESTÃO
 *
 *   1. "um teste que afirme «o agente não confirma pagamento» passa numa
 *       implementação em que gerar link também nunca funciona. Afirme os dois
 *       lados: o link é gerado E o status só muda pelo webhook."
 *      -> §4: a query da RESERVA e a do REGISTRO, tiradas do JSON da tool,
 *         produzem uma cobrança com `link_id`/`url` — e o status continua
 *         `aguardando_pagamento`. Só a query do JSON do WEBHOOK o leva a `pago`.
 *
 *   2. "idempotência pelo EFEITO: reenvie o mesmo evento e verifique o estado
 *       do banco, não o código de resposta."
 *      -> §4: md5 de um retrato (pedidos + cobranças + eventos) antes e depois
 *         do reenvio, idêntico. A sabotagem S2 troca o id do evento por um
 *         `Date.now()` e exige que o retrato acuse.
 *
 *   3. "a regra 3 do portão testada só com pedido não pago passa numa
 *       implementação que barra sempre. Monte o espelho."
 *      -> §4: o `n8n/aplica-portao.js` é executado com o `pagamento_confirmado`
 *         LIDO DO BANCO por `api_n8n_estado_pedido` — antes do webhook a
 *         afirmação é BARRADA, depois do webhook a MESMA afirmação PASSA.
 *         (O espelho isolado, com sabotagens, está em `teste:portao-pagamento`.)
 *
 * ---------------------------------------------------------------------------
 * O QUE ELE EXECUTA É O DERIVADO: as queries vêm dos JSONs gerados, o corpo do
 * `Monta Resposta` e do `Extrai Evento` vêm dos JSONs, e o gerador do principal
 * é DISPARADO com a flag para provar que se recusa. Roda em transação
 * abortada, tenant efêmero.
 *
 * Uso: npm run teste:tool-pagamento
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import * as PAG from '../agente/regras/tool-pagamento-fonte.mjs';

// 05/10: a pasta `n8n/` foi apagada. As seções que liam os JSONs dos workflows
// (estrutura dos nós, ligações do principal, identidade nó↔arquivo) perderam o
// outro lado do par e saíram. O que ficou é o que roda contra o CÓDIGO VIVO: a
// fonte `.mjs`/`.js` que o serviço importa e executa, e o efeito no banco.

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ler = (rel) => JSON.parse(fs.readFileSync(path.join(RAIZ, rel), 'utf8'));
// Os corpos que o SERVIÇO executa. Eram lidos do `jsCode` dos nós, que eram
// cópia destes arquivos; com a pasta `n8n/` apagada, o arquivo é a fonte.
const RESPOSTA_JS = fs.readFileSync(path.join(RAIZ, 'agente', 'regras', 'tool-pagamento-resposta.js'), 'utf8');
const EXTRAI_JS = fs.readFileSync(path.join(RAIZ, 'agente', 'regras', 'webhook-pagamento-extrai.js'), 'utf8');
const PORTAO = fs.readFileSync(path.join(RAIZ, 'agente', 'regras', 'aplica-portao.js'), 'utf8');
const md5 = (t) => crypto.createHash('md5').update(typeof t === 'string' ? t : JSON.stringify(t), 'utf8').digest('hex').slice(0, 12);

let ok = 0;
const falhas = [];
const chk = (nome, cond, det = '') => {
  if (cond) { ok++; console.log(`  OK    ${nome}`); }
  else { falhas.push(nome); console.log(`  FALHA ${nome}${det ? ` — ${det}` : ''}`); }
};
const no = (w, nome) => w.nodes.find((n) => n.name === nome);
const alcanca = (w, de, alvo, v = new Set()) => de === alvo
  || (!v.has(de) && (v.add(de), (w.connections[de]?.main ?? []).flat().some((c) => c && alcanca(w, c.node, alvo, v))));

/** Roda o corpo de um nó Code com `$input` de mentira. */
function rodarCode(fonte, json) {
  // eslint-disable-next-line no-new-func
  return new Function('$input', fonte)({ first: () => ({ json }) })[0].json;
}
/** Roda o portão (arquivo) com estado e texto. */
function rodarPortao(texto, estado) {
  const est = { output: texto, componentes_json: '{}' };
  const $ = (n) => { if (n === 'Estima Tokens') return { first: () => ({ json: est }) }; throw new Error(n); };
  // eslint-disable-next-line no-new-func
  return new Function('$input', '$', PORTAO)({ first: () => ({ json: estado }) }, $)[0].json;
}

console.log('\n== 3. O texto que volta ao modelo, por caso ==\n');
// ===========================================================================
{
  const corpo = RESPOSTA_JS;
  const base = { ok: true, motivo: 'ok', pedido_numero: 7, valor_centavos: 6990, expira_em: '2026-09-11T15:30:00.000Z', ja_existia: false };
  const okNovo = rodarCode(corpo, { reserva: base, asaas: { id: 'pl_x', url: 'https://sandbox.asaas.com/c/abc123' } }).resultado;
  chk('ok: a URL vai CRUA, sozinha numa linha', /\nhttps:\/\/sandbox\.asaas\.com\/c\/abc123\n/.test(okNovo), okNovo);
  chk('ok: sem markdown de link', !/\]\(/.test(okNovo) && !/\[/.test(okNovo));
  chk('ok: diz o valor do BANCO (R$ 69,90) e o número', /R\$ 69,90/.test(okNovo) && /nº 7/.test(okNovo));
  chk('ok: manda copiar exatamente, sem encurtar', /sem encurtar/.test(okNovo));
  chk('ok: a hora de validade está em Brasília (12:30, de 15:30Z)', /12:30/.test(okNovo), okNovo);
  chk('ok: a ÚNICA frase sobre o futuro manda NÃO afirmar pagamento', /NAO afirme que o pagamento foi feito/.test(okNovo));

  const reuso = rodarCode(corpo, { reserva: { ...base, ja_existia: true, url: 'https://sandbox.asaas.com/c/velho' } }).resultado;
  chk('reuso: devolve a URL que já existia e diz que é a mesma', /c\/velho/.test(reuso) && /mesmo link/.test(reuso));

  const abaixo = rodarCode(corpo, { reserva: { ok: false, motivo: 'abaixo_do_minimo', pedido_numero: 8, valor_centavos: 300, minimo_centavos: 500, faltam_centavos: 200 } }).resultado;
  chk('abaixo_do_minimo: diz QUANTO falta (R$ 2,00) e o piso (R$ 5,00)', /R\$ 2,00/.test(abaixo) && /R\$ 5,00/.test(abaixo), abaixo);
  chk('abaixo_do_minimo: sugere COMPLETAR o pedido primeiro', /completar o pedido/.test(abaixo));
  chk('abaixo_do_minimo: atendente só se o cliente não quiser', /nao quiser completar, transfira/.test(abaixo));
  chk('abaixo_do_minimo: nunca o 400 cru', !/valor mínimo para cobranças/i.test(abaixo));

  for (const [motivo, re] of [
    ['tool_inativa', /nao esta disponivel/],
    ['sem_pedido_fechado', /Feche o pedido primeiro/],
    ['ja_pago', /JA ESTA PAGO/],
    ['total_zero', /total zero/],
  ]) {
    chk(`${motivo}: frase própria`, re.test(rodarCode(corpo, { reserva: { ok: false, motivo, pedido_numero: 1 } }).resultado));
  }
  const falha = rodarCode(corpo, { reserva: base, falha_http: true }).resultado;
  chk('falha do Asaas: NÃO inventa link e manda transferir', /NAO invente um link/.test(falha) && /transfira/.test(falha));
  chk('falha do Asaas: nenhuma URL no texto', !/https?:\/\//.test(falha));
}

// ===========================================================================
console.log('\n== 3b. O webhook extrai só o que o banco recebe ==\n');
// ===========================================================================
{
  const corpo = EXTRAI_JS;
  const saida = rodarCode(corpo, {
    headers: { 'asaas-access-token': 'tok'.repeat(12), 'content-type': 'application/json' },
    body: { id: 'evt_abc&123', event: 'PAYMENT_RECEIVED',
      payment: { id: 'pay_1', paymentLink: 'pl_1', externalReference: 'ref-uuid', value: 5.0, customer: 'cus_1', description: 'x' },
      // dados do pagador que NÃO podem seguir
      customerData: { name: 'Fulano', cpfCnpj: '000' } },
  });
  chk('extrai token, id do evento, tipo, ids e referência',
    saida.webhook_token === 'tok'.repeat(12) && saida.evento_id === 'evt_abc&123' && saida.evento === 'PAYMENT_RECEIVED'
    && saida.pagamento_id === 'pay_1' && saida.link_id === 'pl_1' && saida.referencia === 'ref-uuid');
  chk('valor vira INTEIRO em centavos (5.0 -> 500)', saida.valor_centavos === 500, String(saida.valor_centavos));
  chk('e NADA do pagador atravessa (só as 7 chaves)',
    Object.keys(saida).length === 7 && !JSON.stringify(saida).includes('Fulano'));
  // (o grafo do webhook — método, path, ligações dos nós — saiu com o n8n. O
  //  serviço expõe `POST /asaas` e o caminho dele é medido em teste:agente-servico.)
  // (as asserções sobre os nós do webhook do n8n — corpo da resposta ao Asaas,
  //  mensagem pública ao cliente, nota privada — saíram com ele. O mesmo
  //  comportamento é medido no serviço em teste:agente-servico, §webhook Asaas.)
  // A POLÍTICA, DECIDIDA — e escrita em DOIS lugares (a fonte e o doc §6.9).
  // A guarda contra divergirem: o rótulo do doc tem de ser o da fonte, e o
  // encerramento derivado dela tem de dizer que é obrigatório. Se alguém
  // reescrever um lado, o outro acusa.
  chk('POLITICA_EXPIRACAO está decidida (não é null) e é um rótulo válido',
    ['expirou_recusa', 'expirou_aceita'].includes(PAG.POLITICA_EXPIRACAO), String(PAG.POLITICA_EXPIRACAO));
  const doc = fs.readFileSync(path.join(RAIZ, 'docs', 'ENTREGA-PAGAMENTO-ASAAS-SANDBOX.md'), 'utf8');
  const noDoc = doc.match(/veredito da B: \*\*(\w+)\*\*/);
  chk('o doc §6.9 escreve o MESMO rótulo que a fonte (`veredito da B: **<rótulo>**`)',
    noDoc !== null && noDoc[1] === PAG.POLITICA_EXPIRACAO, `doc=${noDoc?.[1]} fonte=${PAG.POLITICA_EXPIRACAO}`);
  chk('ENCERRAMENTO é derivado da política (mesma função, mesmo valor)',
    JSON.stringify(PAG.encerramentoDaPolitica(PAG.POLITICA_EXPIRACAO)) === JSON.stringify(PAG.ENCERRAMENTO));
  chk('com `expirou_aceita`, o encerramento é OBRIGATÓRIO: desativa o link E remove a cobrança pendente, agendado',
    PAG.POLITICA_EXPIRACAO !== 'expirou_aceita'
    || (PAG.ENCERRAMENTO.obrigatorio === true && PAG.ENCERRAMENTO.desativa_link === true
        && PAG.ENCERRAMENTO.remove_cobrancas_pendentes === true && PAG.ENCERRAMENTO.disparo === 'agendado'));
  chk('e quem CONFIRMA o pagamento não desliga o link: o encerramento é da manutenção, não do webhook',
    !/paymentLinks|active": false/.test(fs.readFileSync(path.join(RAIZ, 'agente', 'src', 'pagamento', 'webhook.ts'), 'utf8')));
}

console.log('\n== 5. SABOTAGEM (sem banco) ==\n');
// ===========================================================================
{
  // S1 — um $fromAI de valor na tool. A guarda do gerador reprova; aqui a
  //      asserção do §1 tem de reprovar também.
  // 05/10: mutava o JSON da tool do n8n. O alvo vivo é a FONTE do serviço: se
  // alguém puser um `$fromAI` (valor escolhido pelo modelo) no caminho do
  // pagamento, é aqui que apareceria.
  const semComentario = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  // sem os comentários: a fonte EXPLICA o `$fromAI` em prosa, e um regex cru
  // casaria com a explicação — a armadilha do auto-casamento do CLAUDE.md.
  const fonteTool = semComentario(fs.readFileSync(path.join(RAIZ, 'agente', 'regras', 'tool-pagamento-fonte.mjs'), 'utf8'));
  const comFromAI = fonteTool + "\nconst x = $fromAI('valor', 'quanto cobrar', 'number');";
  chk('S1: a varredura ACHA um $fromAI de valor quando ele existe', /\$fromAI\(/.test(comFromAI));
  chk('S1: ...e NÃO acha na fonte de verdade (o valor nunca vem do modelo)', !/\$fromAI\(/.test(fonteTool));

  // S3 — tirar a frase "NAO afirme que o pagamento foi feito" do Monta Resposta.
  const corpo = RESPOSTA_JS;
  const alvo = "'NAO afirme que o pagamento foi feito ou confirmado: o sistema avisa quando cair.'";
  const n = corpo.split(alvo).length - 1;
  if (n !== 1) chk('S3 localizou o alvo', false, `${n}x`);
  else {
    const mut = corpo.split(alvo).join("''");
    console.log(`     [mutou "sem o aviso de nunca confirmar": md5 ${md5(corpo)} -> ${md5(mut)}]`);
    const r = rodarCode(mut, { reserva: { ok: true, motivo: 'ok', pedido_numero: 1, valor_centavos: 500, expira_em: null, ja_existia: false }, asaas: { id: 'x', url: 'https://u' } }).resultado;
    chk('S3: sem o aviso, a resposta positiva deixa de mandar NÃO afirmar pagamento', !/NAO afirme/.test(r));
  }
}

console.log(`\n${'-'.repeat(62)}`);
console.log(`  ${ok} passaram, ${falhas.length} falharam`);
if (falhas.length) { for (const f of falhas) console.log(`    - ${f}`); process.exit(1); }
