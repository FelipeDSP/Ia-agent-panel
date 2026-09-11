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
import * as PAG from '../n8n/tool-pagamento-fonte.mjs';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ler = (rel) => JSON.parse(fs.readFileSync(path.join(RAIZ, rel), 'utf8'));
const TOOL = ler('n8n/workflows/tool-gerar-link-pagamento.json');
const WH = ler('n8n/workflows/webhook-pagamento-asaas.json');
const PRINCIPAL = ler('n8n/workflows/agente-principal.json');
const PORTAO = fs.readFileSync(path.join(RAIZ, 'n8n', 'aplica-portao.js'), 'utf8');
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

// ===========================================================================
console.log('\n== 1. A ferramenta: o que o modelo NÃO controla ==\n');
// ===========================================================================
{
  const bruto = JSON.stringify(TOOL);
  chk('nenhum `$fromAI` no sub-workflow (valor, produto, prazo: nada vem do modelo)', !/\$fromAI\(/.test(bruto));
  chk('nenhuma chave do Asaas cravada', !/aact_/.test(bruto));
  const trg = no(TOOL, 'When Executed by Another Workflow');
  chk('as entradas são SÓ tenant_id e conversation_id',
    JSON.stringify(trg.parameters.workflowInputs.values.map((v) => v.name)) === JSON.stringify(PAG.ENTRADAS.map((e) => e.name)));
  chk('`tool_ativa` é a primeira coisa: trigger -> Busca Config -> Pagamento Ativa?',
    TOOL.connections['When Executed by Another Workflow'].main[0][0].node === 'Busca Config'
    && TOOL.connections['Busca Config'].main[0][0].node === 'Pagamento Ativa?'
    && /api_n8n_config_tool\(\$1::uuid, 'pagamento'\)/.test(no(TOOL, 'Busca Config').parameters.query));
  const res = no(TOOL, 'Reserva Cobranca');
  chk('a reserva chama api_n8n_gerar_cobranca($1, $2) — dois argumentos, sem valor',
    /api_n8n_gerar_cobranca\(\$1::uuid, \$2::bigint\)/.test(res.parameters.query) && !/\$3/.test(res.parameters.query));
  const http = no(TOOL, 'Cria Link Asaas');
  chk('o nó HTTP usa a base e a chave DO TENANT (da linha da reserva), não host fixo',
    http.parameters.url === '={{ $json.base_url }}/v3/paymentLinks'
    && http.parameters.headerParameters.parameters.some((h) => h.name === 'access_token' && h.value === '={{ $json.api_key }}')
    && !/asaas\.com/.test(http.parameters.url));
  chk('o corpo leva dueDateLimitDays=1, value em decimal só na fronteira, e externalReference',
    new RegExp(`dueDateLimitDays: ${PAG.DUE_DATE_LIMIT_DAYS}\\b`).test(http.parameters.body)
    && /value: Math\.round\(Number\(\$json\.valor_centavos\)\) \/ 100/.test(http.parameters.body)
    && /externalReference: \$json\.referencia_externa/.test(http.parameters.body));
  chk('o Asaas fora do ar não derruba a execução (onError no HTTP)', http.onError === 'continueRegularOutput');
  for (const n of TOOL.nodes) {
    if (n.name === 'Retorno') continue;
    chk(`"${n.name}" chega ao Retorno`, alcanca(TOOL, n.name, 'Retorno'));
  }
  const fonte = fs.readFileSync(path.join(RAIZ, 'n8n', 'tool-pagamento-resposta.js'), 'utf8').replace(/\r\n/g, '\n');
  chk('o jsCode do Monta Resposta == n8n/tool-pagamento-resposta.js', no(TOOL, 'Monta Resposta').parameters.jsCode === fonte,
    `${md5(no(TOOL, 'Monta Resposta').parameters.jsCode)} vs ${md5(fonte)}`);
}

// ===========================================================================
console.log('\n== 2. O principal do EXPERIMENTO continua sem a ferramenta ==\n');
// ===========================================================================
{
  chk('o agente-principal.json do repo NÃO tem o nó de pagamento', !no(PRINCIPAL, PAG.NO_PRINCIPAL));
  const sm = no(PRINCIPAL, 'AI Agent Vendas').parameters.options.systemMessage;
  chk('nem a seção `gerar_link_pagamento` no system message', !sm.includes('## Ferramenta: gerar_link_pagamento'));
  const ligadas = Object.entries(PRINCIPAL.connections)
    .filter(([, v]) => (v.ai_tool ?? []).flat().some((d) => d?.node === 'AI Agent Vendas')).length;
  chk('e o AI Agent Vendas segue com 6 tools (a fusão, intacta)', ligadas === 6, String(ligadas));

  // O GERADOR SE RECUSA com a flag enquanto o id for placeholder — disparado de
  // verdade, e o arquivo tem de sair intocado.
  const antes = md5(fs.readFileSync(path.join(RAIZ, 'n8n', 'workflows', 'agente-principal.json'), 'utf8'));
  const r = spawnSync(process.execPath, ['scripts/gerar-principal.mjs'], {
    cwd: RAIZ, env: { ...process.env, GERAR_COM_PAGAMENTO: '1' }, encoding: 'utf8',
  });
  const depois = md5(fs.readFileSync(path.join(RAIZ, 'n8n', 'workflows', 'agente-principal.json'), 'utf8'));
  chk('GERAR_COM_PAGAMENTO=1 com o id placeholder -> o gerador ABORTA (exit 1)', r.status === 1, `exit=${r.status}`);
  chk('  ...com a mensagem certa', /placeholder/.test(r.stderr + r.stdout));
  chk('  ...e o agente-principal.json ficou INTOCADO (md5)', antes === depois, `${antes} -> ${depois}`);
  chk('o id do sub-workflow na fonte ainda é o placeholder (o import não aconteceu)', /^PENDENTE/.test(PAG.ID_WORKFLOW));
}

// ===========================================================================
console.log('\n== 3. O texto que volta ao modelo, por caso ==\n');
// ===========================================================================
{
  const corpo = no(TOOL, 'Monta Resposta').parameters.jsCode;
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
  const corpo = no(WH, 'Extrai Evento').parameters.jsCode;
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
  const wh = no(WH, 'Webhook Asaas');
  chk('path próprio, sem colidir com o principal nem com o passo 0',
    wh.parameters.path === 'asaas-pagamento-sandbox'
    && !['agente-lavanderia-chatwoot-teste-teste', 'chatwoot-sandbox-pagamento'].includes(wh.parameters.path));
  chk('responde ANTES de notificar (Aplica Webhook -> Responde 200 -> IFs)',
    WH.connections['Aplica Webhook'].main[0][0].node === 'Responde 200'
    && WH.connections['Responde 200'].main[0].map((c) => c.node).sort().join(',') === 'Aplicou?,Precisa Humano?');
  chk('a resposta ao Asaas leva só o estado, sem tenant/conversa/valor',
    !/tenant_id|conversation_id|total_centavos|mensagem/.test(no(WH, 'Responde 200').parameters.responseBody));
  chk('a notificação ao cliente é `outgoing` e pública, pela credencial de Agent Bot',
    /message_type: 'outgoing', private: false/.test(no(WH, 'Notifica Cliente').parameters.body)
    && /api_n8n_credencial_chatwoot/.test(no(WH, 'Credencial Chatwoot').parameters.query));
  chk('a nota de fora do prazo é PRIVADA', /private: true/.test(no(WH, 'Nota Privada Fora do Prazo').parameters.body));
  chk('POLITICA_EXPIRACAO ainda é null: nenhum passo de desativação foi ligado',
    PAG.POLITICA_EXPIRACAO === null && !JSON.stringify(WH).includes('active": false'));
}

// ===========================================================================
console.log('\n== 4. Os três casos, com as queries DOS JSONs, no banco ==\n');
// ===========================================================================
const url = fs.readFileSync(path.join(RAIZ, '.env.local'), 'utf8').split(/\r?\n/)
  .find((l) => l.startsWith('SUPABASE_DB_URL=')).slice('SUPABASE_DB_URL='.length).trim().replace(/^["']|["']$/g, '');
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await c.connect();
await c.query('begin');
const um = async (q, p = []) => (await c.query(q, p)).rows[0];
const TOKEN = 'tokdeteste' + 'p'.repeat(30);
const retrato = async (t) => {
  const r = await c.query(
    `select (select count(*)::int from public.pagamento_eventos where tenant_id=$1) ev,
            (select count(*)::int from public.pedido_cobrancas where tenant_id=$1) cob,
            (select coalesce(string_agg(p.id::text||'|'||p.status||'|'||p.atualizado_em::text, ',' order by p.id),'') from public.pedidos p where p.tenant_id=$1) ped,
            (select coalesce(string_agg(c.id::text||'|'||coalesce(c.pago_em::text,'-')||'|'||coalesce(c.pagamento_id,'-')||'|'||coalesce(c.notificado_em::text,'-'), ',' order by c.id),'') from public.pedido_cobrancas c where c.tenant_id=$1) cobs`,
    [t]);
  return md5(r.rows[0]);
};

/** Executa a query de um nó Postgres do JSON, com `$n` mapeado por posição. */
const q = (w, nome, params) => c.query(no(w, nome).parameters.query, params);

try {
  const T = (await um(`insert into public.tenants (slug, nome) values ('z-teste-pag-tool', 'Teste Pag') returning id`)).id;
  await c.query(`insert into public.tenant_credenciais (tenant_id, asaas_ambiente, asaas_api_key_sandbox, asaas_webhook_token_sandbox)
                 values ($1, 'sandbox', 'sk_sandbox_tool', $2)`, [T, TOKEN]);
  await c.query(`insert into public.tenant_tools (tenant_id, tool_nome, ativo, contratado) values ($1,'pagamento',true,true), ($1,'vendas',true,true)`, [T]);
  const prod = (await um(`insert into public.produtos (tenant_id, nome, preco_centavos, unidade, disponivel) values ($1,'Curso',6990,'un',true) returning id`, [T])).id;
  const CONV = 880001;
  await c.query(`select public.api_n8n_adicionar_item($1,$2,$3,1,null)`, [T, CONV, prod]);
  await c.query(`select public.api_n8n_fechar_pedido($1,$2,null)`, [T, CONV]);
  const ped = await um(`select id, status, numero from public.pedidos where tenant_id=$1 and conversation_id=$2`, [T, CONV]);
  chk('arranjo: pedido fechado (aguardando_pagamento)', ped.status === 'aguardando_pagamento');

  // --- tool_ativa primeiro, pela query do JSON ---
  const cfg = (await q(TOOL, 'Busca Config', [T])).rows[0];
  chk('Busca Config (query do JSON) diz tool_ativa=true para quem contratou', cfg.tool_ativa === true);

  // --- a RESERVA, pela query do JSON ---
  const reserva = (await q(TOOL, 'Reserva Cobranca', [T, CONV])).rows[0];
  chk('reserva: ok, com a chave DO TENANT e a base derivada do ambiente',
    reserva.ok === true && reserva.api_key === 'sk_sandbox_tool' && reserva.base_url === 'https://api-sandbox.asaas.com',
    `${reserva.motivo} / ${reserva.base_url}`);
  chk('reserva: o valor é o do pedido (6990), e não há parâmetro por onde entrar outro', reserva.valor_centavos === 6990);

  // --- o REGISTRO, pela query do JSON (o Asaas é simulado: id + url) ---
  await q(TOOL, 'Registra Cobranca', [T, reserva.cobranca_id, 'pl_teste_tool', 'https://sandbox.asaas.com/c/pl_teste_tool']);
  const cob = await um(`select link_id, url, pago_em from public.pedido_cobrancas where id=$1`, [reserva.cobranca_id]);
  chk('CASO 1, lado A: o link FOI gerado (link_id e url no banco)', cob.link_id === 'pl_teste_tool' && /pl_teste_tool/.test(cob.url));
  const stDepoisDoLink = (await um(`select status from public.pedidos where id=$1`, [ped.id])).status;
  chk('CASO 1, lado B: gerar o link NÃO muda o status (continua aguardando_pagamento)', stDepoisDoLink === 'aguardando_pagamento', stDepoisDoLink);

  // --- a REGRA 3 antes do pagamento: afirmar "caiu" é BARRADO ---
  const estadoAntes = await um(`select * from public.api_n8n_estado_pedido($1,$2)`, [T, CONV]);
  const r1 = rodarPortao('Pagamento confirmado! ✅ Já pode acessar o curso.', estadoAntes);
  chk('CASO 3, antes do webhook: pagamento_confirmado=false e a afirmação é BARRADA pela regra 3',
    estadoAntes.pagamento_confirmado === false && r1._portao.veredito === 'barrado_regra_3', r1._portao.veredito);

  // --- o WEBHOOK, pela query do JSON ---
  const ev = ['evt_tool_1', 'PAYMENT_RECEIVED', 'pay_tool_1', 'pl_teste_tool', reserva.cobranca_id, 6990];
  const w1 = (await q(WH, 'Aplica Webhook', [TOKEN, ...ev])).rows[0];
  chk('webhook (query do JSON): reconhecido e APLICOU', w1.reconhecido === true && w1.aplicou === true, w1.motivo);
  chk('CASO 1, lado B: SÓ o webhook levou o pedido a `pago`',
    (await um(`select status from public.pedidos where id=$1`, [ped.id])).status === 'pago');
  chk('e a mensagem ao cliente veio pronta do banco, com o valor', /R\$ 69,90/.test(w1.mensagem) && /confirmado/i.test(w1.mensagem));

  // --- CASO 2: reenvio do MESMO evento, estado idêntico ---
  const antes = await retrato(T);
  const w2 = (await q(WH, 'Aplica Webhook', [TOKEN, ...ev])).rows[0];
  const depois = await retrato(T);
  chk('CASO 2: reenvio -> ja_processado, não aplica, sem mensagem', w2.ja_processado === true && w2.aplicou === false && w2.mensagem === null);
  chk('CASO 2: e o ESTADO DO BANCO é idêntico (md5 do retrato)', antes === depois, `${antes} vs ${depois}`);

  // --- CASO 3, o ESPELHO: depois do webhook, a MESMA afirmação PASSA ---
  const estadoDepois = await um(`select * from public.api_n8n_estado_pedido($1,$2)`, [T, CONV]);
  const r2 = rodarPortao('Pagamento confirmado! ✅ Já pode acessar o curso.', estadoDepois);
  chk('CASO 3, depois do webhook: pagamento_confirmado=true e a MESMA afirmação PASSA',
    estadoDepois.pagamento_confirmado === true && r2._portao.veredito === 'passou', r2._portao.veredito);

  // --- token errado não faz nada ---
  const wf = (await q(WH, 'Aplica Webhook', ['x'.repeat(40), 'evt_forjado', 'PAYMENT_RECEIVED', null, null, reserva.cobranca_id, 6990])).rows[0];
  chk('token desconhecido -> reconhecido=false, nada aplicado, nenhum evento gravado',
    wf.reconhecido === false && (await um(`select count(*)::int n from public.pagamento_eventos where evento_id='evt_forjado'`)).n === 0);

  // --- SABOTAGEM S2: evento_id por Date.now() no Code do webhook ---
  {
    const corpo = no(WH, 'Extrai Evento').parameters.jsCode;
    const alvo = "evento_id: String(body.id ?? ''),";
    const n = corpo.split(alvo).length - 1;
    if (n !== 1) chk('S2 localizou o alvo', false, `${n}x`);
    else {
      const mut = corpo.split(alvo).join("evento_id: String(Date.now()) + Math.random(),");
      console.log(`     [mutou "evento_id aleatorio": md5 ${md5(corpo)} -> ${md5(mut)}]`);
      const payload = { headers: { 'asaas-access-token': TOKEN }, body: { id: 'evt_tool_1', event: 'PAYMENT_RECEIVED', payment: { id: 'pay_tool_1', paymentLink: 'pl_teste_tool', externalReference: reserva.cobranca_id, value: 69.9 } } };
      const a = rodarCode(mut, payload); const b = rodarCode(mut, payload);
      const antesS = await retrato(T);
      await q(WH, 'Aplica Webhook', [a.webhook_token, a.evento_id, a.evento, a.pagamento_id, a.link_id, a.referencia, a.valor_centavos]);
      await q(WH, 'Aplica Webhook', [b.webhook_token, b.evento_id, b.evento, b.pagamento_id, b.link_id, b.referencia, b.valor_centavos]);
      const depoisS = await retrato(T);
      chk('S2: com id aleatório, o "mesmo" evento entra duas vezes e o retrato ACUSA', antesS !== depoisS);
      chk('  ...mas o pedido continua pago UMA vez (a camada 2 segura o estado)',
        (await um(`select count(*)::int n from public.pedidos where tenant_id=$1 and status='pago'`, [T])).n === 1);
    }
  }
} catch (e) {
  falhas.push('exceção');
  console.log(`\n  EXCEÇÃO: ${e.code ?? ''} ${e.message}`);
} finally {
  await c.query('rollback');
  await c.end();
}

// ===========================================================================
console.log('\n== 5. SABOTAGEM (sem banco) ==\n');
// ===========================================================================
{
  // S1 — um $fromAI de valor na tool. A guarda do gerador reprova; aqui a
  //      asserção do §1 tem de reprovar também.
  const sab = JSON.parse(JSON.stringify(TOOL));
  const res = no(sab, 'Reserva Cobranca');
  const antes = md5(res.parameters);
  res.parameters.query = "SELECT * FROM public.api_n8n_gerar_cobranca($1::uuid, $2::bigint, $3::integer);";
  res.parameters.options.queryReplacement = "={{ [ a, b, $fromAI('valor', 'quanto cobrar', 'number') ] }}";
  console.log(`     [mutou "valor via $fromAI": md5 ${antes} -> ${md5(res.parameters)}]`);
  chk('S1: $fromAI na tool é detectado', /\$fromAI\(/.test(JSON.stringify(sab)));

  // S3 — tirar a frase "NAO afirme que o pagamento foi feito" do Monta Resposta.
  const corpo = no(TOOL, 'Monta Resposta').parameters.jsCode;
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
