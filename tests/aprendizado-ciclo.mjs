/**
 * O ciclo do aprendizado automático, ponta a ponta, contra o banco.
 *
 * Rollback-first, 78 duas vezes. O que ele prova, e por que cada uma importa:
 *
 *  - O BOTÃO MANDA. Tenant com `aprendizado_auto = false` não aparece em
 *    `api_agente_aprendizado_pendentes` — é a única coisa que o cliente
 *    autorizou, e se vazar daqui o ciclo roda em quem não pediu;
 *  - a LLM decide: modelo dizendo "não guardar" não publica, e o motivo dele
 *    fica na auditoria;
 *  - a ÂNCORA pega invenção: modelo que devolve um prazo que ninguém disse é
 *    descartado por `nao_ancorado`, mesmo tendo dito "guardar: true";
 *  - o que publica vai pelo caminho normal de ingestão (job + Edge Function),
 *    e a linha de auditoria aponta para a origem dos chunks;
 *  - idempotência: a segunda rodada não reprocessa o mesmo par;
 *  - isolamento: `painel_aprendizado_recente` só devolve o do tenant do JWT,
 *    com CONTRAPROVA de que o do outro existe.
 *
 *   npm run teste:aprendizado-ciclo
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(RAIZ, 'supabase', 'migrations');
const leia = (n) => fs.readFileSync(path.join(DIR, n), 'utf8').replace(/\r\n/g, '\n');
const M78 = leia('20261001120000_78_aprendizado_automatico.sql');
const R78 = leia('20261001120000_78_aprendizado_automatico_rollback.sql');
const semTx = (s) => s.replace(/^\s*(begin|commit)\s*;\s*$/gim, '');
const { cicloAprendizado } = await import(new URL('../agente/src/aprendizado/ciclo.ts', import.meta.url).href);

let ok = 0;
const falhas = [];
const chk = (nome, cond, det = '') => {
  if (cond) { ok++; console.log(`  OK    ${nome}`); }
  else { falhas.push(nome); console.log(`  FALHA ${nome}${det ? ` — ${det}` : ''}`); }
};
const url = process.env.SUPABASE_DB_URL ?? fs.readFileSync(path.join(RAIZ, '.env.local'), 'utf8')
  .split(/\r?\n/).find((l) => l.startsWith('SUPABASE_DB_URL='))?.slice('SUPABASE_DB_URL='.length).trim().replace(/^["']|["']$/g, '');
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await c.connect();
await c.query('begin');
const um = async (sql, p = []) => (await c.query(sql, p)).rows[0];
const tudo = async (sql, p = []) => (await c.query(sql, p)).rows;

// O "db" que o serviço usa é esta mesma conexão: tudo roda na transação abortada.
const db = { query: (sql, p) => c.query(sql, p) };

// --- modelo falso: devolve o que o roteiro mandar, e registra o que viu ------
const vistoPeloModelo = [];
let respostaDoModelo = '{"guardar": false, "motivo": "nao configurado"}';
const modelo = {
  async responder(p) {
    vistoPeloModelo.push({ systemMessage: p.systemMessage, transcricao: p.mensagemDoCliente, ferramentas: p.ferramentas.length, temperatura: p.temperatura });
    return { texto: respostaDoModelo, chamadas: 1, usage: null };
  },
};
// --- Edge Function falsa ----------------------------------------------------
const chamadasIngestao = [];
let ingestaoFalha = false;
const fetchFalso = async (u, init) => {
  chamadasIngestao.push({ url: String(u), corpo: JSON.parse(String(init?.body ?? '{}')), segredo: init?.headers?.['x-ingestao-secret'] ?? null });
  if (ingestaoFalha) return new Response(JSON.stringify({ ok: false, job: { status: 'erro', erro_msg: 'OpenAI fora' } }), { status: 200 });
  return new Response(JSON.stringify({ ok: true, job: { status: 'concluido' } }), { status: 200 });
};
const deps = () => ({ db, fetchFn: fetchFalso, modelo, nomeDoModelo: 'gpt-teste', supabaseUrl: 'https://proj.supabase.co', ingestaoSecret: 'seg-teste', silencioMinutos: 15, limite: 20 });

const DIALOGO_RESPOSTA = 'O certificado e emitido em ate 30 dias uteis apos a conclusao das provas, e a retirada e na secretaria, de segunda a sexta.';

try {
  console.log('\n== 0. Rollback primeiro, 78 duas vezes ==\n');
  await c.query(semTx(R78));
  chk('pré-78: sem a coluna e sem a tabela',
    (await um(`select count(*)::int n from information_schema.columns where table_name='tenants' and column_name='aprendizado_auto'`)).n === 0
    && (await um(`select count(*)::int n from information_schema.tables where table_name='kb_aprendizado'`)).n === 0);
  await c.query(semTx(M78)); await c.query(semTx(M78));
  chk('a 78 aplica duas vezes; coluna, tabela e funções existem',
    (await um(`select count(*)::int n from information_schema.columns where table_name='tenants' and column_name='aprendizado_auto'`)).n === 1
    && (await um(`select count(*)::int n from pg_proc p join pg_namespace x on x.oid=p.pronamespace where x.nspname='public' and p.proname in ('api_agente_aprendizado_pendentes','api_agente_aprendizado_dialogo','api_agente_aprendizado_concluir','api_agente_kb_job_texto','painel_aprendizado_recente')`)).n === 5);
  const aclIrma = (await um(`select p.proacl::text a from pg_proc p join pg_namespace x on x.oid=p.pronamespace where x.nspname='public' and p.proname='api_agente_horario'`)).a;
  const aclNova = (await um(`select p.proacl::text a from pg_proc p join pg_namespace x on x.oid=p.pronamespace where x.nspname='public' and p.proname='api_agente_aprendizado_pendentes'`)).a;
  chk('ACL das funções do serviço == a da irmã api_agente_horario', aclNova === aclIrma, `${aclNova} vs ${aclIrma}`);
  chk('a tabela nova NÃO ficou aberta para anon (o default do projeto abre tudo)',
    !/anon=/.test((await um(`select relacl::text a from pg_class where relname='kb_aprendizado'`)).a ?? ''), (await um(`select relacl::text a from pg_class where relname='kb_aprendizado'`)).a);

  console.log('\n== 1. Arranjo: dois tenants, um com o botão LIGADO ==\n');
  const T = {};
  for (const s of ['a', 'b']) T[s] = (await um(`insert into public.tenants (slug, nome, modelo) values ($1, $2, 'gpt-teste') returning id`, [`z-teste-78-${s}`, `Teste 78 ${s}`])).id;
  await c.query(`update public.tenants set aprendizado_auto = true where id = $1`, [T.a]);

  // Em cada tenant: transferência (a pergunta) + fala do cliente + fala do atendente.
  const semear = async (t, conv, respostaHumana) => {
    const turno = await um(`insert into public.agente_turnos (tenant_id, conversation_id, acao, status, modelo, perfil, iniciado_em)
      values ($1, $2, 'processar', 'ok', 'gpt-teste', 'basico', now() - interval '2 hours') returning id`, [t, conv]);
    await c.query(`insert into public.agente_passos (tenant_id, turno_id, ordem, tipo, nome, entrada, saida, criado_em)
      values ($1, $2, 1, 'tool', 'transferir_humano', $3::jsonb, $4::jsonb, now() - interval '2 hours')`,
      [t, turno.id, JSON.stringify({ resumo: 'quanto tempo demora o certificado' }), JSON.stringify({ diagnostico: { disponivel: true, pausou: true } })]);
    await c.query(`select public.api_n8n_registrar_mensagem($1, $2, 'entrada', 'quanto tempo demora o certificado?', 0, 0, null, null, $3, null)`, [t, conv, `cli-${t}-${conv}`]);
    await c.query(`select public.api_n8n_registrar_mensagem($1, $2, 'saida', $4, 0, 0, null, null, $3, $5::jsonb)`,
      [t, conv, `humano-${t}-${conv}`, respostaHumana, JSON.stringify({ fonte: 'humano', chamadas: 0 })]);
    // envelhece tudo: a função só pega conversa parada há 15 min
    await c.query(`update public.mensagens_log set criado_em = now() - interval '1 hour' where tenant_id = $1 and conversation_id = $2`, [t, conv]);
  };
  await semear(T.a, 801, DIALOGO_RESPOSTA);
  await semear(T.b, 802, DIALOGO_RESPOSTA);

  const pend = await tudo(`select * from public.api_agente_aprendizado_pendentes(15, 20)`);
  const doA = pend.filter((p) => p.tenant_id === T.a);
  const doB = pend.filter((p) => p.tenant_id === T.b);
  chk('O BOTÃO MANDA: o par do tenant LIGADO aparece; o do desligado NÃO', doA.length === 1 && doB.length === 0, JSON.stringify({ a: doA.length, b: doB.length }));
  chk('o pendente traz a pergunta do resumo da transferência e a resposta do atendente',
    doA[0]?.pergunta === 'quanto tempo demora o certificado' && doA[0]?.resposta === DIALOGO_RESPOSTA, JSON.stringify(doA[0]));
  const dlg = await tudo(`select * from public.api_agente_aprendizado_dialogo($1, $2)`, [T.a, doA[0].mensagem_id]);
  chk('o diálogo da âncora traz as DUAS falas, com o atendente marcado — inclusive a própria âncora (microssegundo não trunca aqui)',
    dlg.length === 2 && dlg[0].direcao === 'entrada' && dlg[1].humano === true, JSON.stringify(dlg.map((d) => [d.direcao, d.humano])));

  console.log('\n== 2. A LLM lê o diálogo ==\n');
  respostaDoModelo = JSON.stringify({ guardar: true, pergunta: 'Qual o prazo de emissao do certificado?', resposta: 'O certificado e emitido em ate 30 dias uteis apos a conclusao das provas, com retirada na secretaria.', motivo: '' });
  const r1 = await cicloAprendizado(deps());
  chk('viu 1, publicou 1', r1.vistos === 1 && r1.publicados === 1 && r1.erros === 0, JSON.stringify(r1));
  const v = vistoPeloModelo.at(-1);
  chk('o modelo recebeu a TRANSCRIÇÃO com os papéis (CLIENTE/ATENDENTE), não só a última fala',
    /CLIENTE: quanto tempo demora/.test(v.transcricao) && /ATENDENTE: O certificado/.test(v.transcricao), v.transcricao.slice(0, 120));
  // `Number(...)`: o guard de comparações de tipo varre o arquivo inteiro e
  // `temperatura` é nome de coluna numeric no banco. Aqui o valor vem do modelo
  // falso, mas a guarda não tem como saber — e afrouxá-la sairia mais caro.
  chk('e recebeu zero ferramentas e temperatura 0 (é leitura, não conversa)', v.ferramentas === 0 && Number(v.temperatura) === 0);
  chk('as instruções proíbem acrescentar fato e mandam recusar caso particular',
    /NAO pode acrescentar nenhum fato/.test(v.systemMessage) && /so vale para aquele cliente/.test(v.systemMessage));

  console.log('\n== 3. O que foi publicado ==\n');
  const ing = chamadasIngestao.at(-1);
  chk('chamou a Edge Function de ingestão com o segredo e o job', /functions\/v1\/processar-ingestao$/.test(ing.url) && ing.segredo === 'seg-teste' && typeof ing.corpo.job_id === 'string');
  chk('o texto enviado leva pergunta e resposta, e declara a origem', /Pergunta: Qual o prazo/.test(ing.corpo.texto) && /30 dias uteis/.test(ing.corpo.texto) && /atendimento humano/i.test(ing.corpo.texto));
  const job = await um(`select arquivo_nome, tipo, status, criado_por from public.jobs_ingestao where id = $1`, [ing.corpo.job_id]);
  chk('o job é de texto, do tenant, e com criado_por NULO (não houve usuário)', job.tipo === 'texto' && job.criado_por === null && /prazo/i.test(job.arquivo_nome));
  const aud = await um(`select * from public.kb_aprendizado where tenant_id = $1`, [T.a]);
  chk('a auditoria gravou publicado, com a origem que liga aos chunks', aud.status === 'publicado' && aud.origem === `texto:${ing.corpo.job_id}`, JSON.stringify({ s: aud.status, o: aud.origem }));

  console.log('\n== 4. Idempotência ==\n');
  const antes = chamadasIngestao.length;
  const r2 = await cicloAprendizado(deps());
  chk('segunda rodada: nada pendente, nenhuma ingestão nova', r2.vistos === 0 && chamadasIngestao.length === antes, JSON.stringify(r2));

  console.log('\n== 5. Quando NÃO publica ==\n');
  // 5a. o modelo diz que não há o que guardar
  await semear(T.a, 803, 'Vou verificar com a coordenacao e te retorno ainda hoje com a resposta certinha, pode ser?');
  respostaDoModelo = JSON.stringify({ guardar: false, motivo: 'atendente nao respondeu de fato' });
  const r3 = await cicloAprendizado(deps());
  const a3 = await um(`select status, motivo from public.kb_aprendizado where tenant_id=$1 and conversation_id=803`, [T.a]);
  chk('modelo recusa -> descartado, com o motivo DELE na auditoria', r3.publicados === 0 && r3.descartados === 1 && a3.status === 'descartado' && /nao respondeu/.test(a3.motivo), JSON.stringify(a3));

  // 5b. o modelo quer guardar, mas inventou o prazo
  await semear(T.a, 804, DIALOGO_RESPOSTA);
  respostaDoModelo = JSON.stringify({ guardar: true, pergunta: 'Qual o prazo do certificado?', resposta: 'O certificado e emitido em ate 15 dias uteis, mediante taxa de 20 reais paga na secretaria.', motivo: '' });
  const r4 = await cicloAprendizado(deps());
  const a4 = await um(`select status, motivo from public.kb_aprendizado where tenant_id=$1 and conversation_id=804`, [T.a]);
  chk('modelo inventa prazo e taxa -> a ÂNCORA reprova (nao_ancorado), nada vai para a base',
    r4.publicados === 0 && a4.status === 'descartado' && a4.motivo === 'nao_ancorado', JSON.stringify(a4));

  // 5c. o modelo devolve lixo
  await semear(T.a, 805, DIALOGO_RESPOSTA);
  respostaDoModelo = 'desculpe, nao consegui';
  const r5 = await cicloAprendizado(deps());
  chk('resposta do modelo sem JSON -> descartado, sem estourar', r5.erros === 0 && r5.descartados === 1,
    JSON.stringify({ r5, a: (await um(`select status, motivo from public.kb_aprendizado where tenant_id=$1 and conversation_id=805`, [T.a])) }));

  // 5d. a ingestão falha
  await semear(T.a, 806, DIALOGO_RESPOSTA);
  respostaDoModelo = JSON.stringify({ guardar: true, pergunta: 'Qual o prazo do certificado?', resposta: 'O certificado e emitido em ate 30 dias uteis, com retirada na secretaria.', motivo: '' });
  ingestaoFalha = true;
  const r6 = await cicloAprendizado(deps());
  ingestaoFalha = false;
  const a6 = await um(`select status, motivo from public.kb_aprendizado where tenant_id=$1 and conversation_id=806`, [T.a]);
  chk('ingestão falhando -> status erro com o detalhe, e NÃO conta como publicado', r6.erros === 1 && r6.publicados === 0 && a6.status === 'erro' && /ingest/i.test(a6.motivo), JSON.stringify(a6));

  console.log('\n== 6. Isolamento da auditoria ==\n');
  // o tenant B passa a ter uma linha também, para a contraprova não ser vácua
  await c.query(`update public.tenants set aprendizado_auto = true where id = $1`, [T.b]);
  respostaDoModelo = JSON.stringify({ guardar: true, pergunta: 'SEGREDO-DE-B prazo?', resposta: 'O certificado e emitido em ate 30 dias uteis, com retirada na secretaria.', motivo: '' });
  await cicloAprendizado(deps());
  const nB = await um(`select count(*)::int n from public.kb_aprendizado where tenant_id=$1`, [T.b]);
  chk('CONTRAPROVA: o tenant B tem linha de aprendizado', nB.n === 1, JSON.stringify(nB));
  const comoTenant = async (t) => {
    await c.query('savepoint sp'); await c.query('set local role authenticated');
    await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ role: 'authenticated', app_metadata: { papel: 'tenant_admin', tenant_id: t } })]);
    const r = await c.query(`select pergunta from public.painel_aprendizado_recente(50)`);
    const tab = await c.query(`select count(*)::int n from public.kb_aprendizado`);
    await c.query('rollback to savepoint sp');
    return { fn: r.rows.map((x) => x.pergunta), tabela: tab.rows[0].n };
  };
  const vistoA = await comoTenant(T.a);
  chk('painel_aprendizado_recente do A não traz nada de B', !vistoA.fn.some((p) => /SEGREDO-DE-B/.test(p)) && vistoA.fn.length >= 1, JSON.stringify(vistoA.fn));
  chk('e a RLS da tabela também não (A conta só as próprias linhas)', vistoA.tabela === (await um(`select count(*)::int n from public.kb_aprendizado where tenant_id=$1`, [T.a])).n, String(vistoA.tabela));

  console.log('\n== 7. O guard: o botão é do CLIENTE ==\n');
  const comoAdmin = async (sql, p) => {
    await c.query('savepoint sp2'); await c.query('set local role authenticated');
    await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ role: 'authenticated', app_metadata: { papel: 'tenant_admin', tenant_id: T.a } })]);
    try { await c.query(sql, p); await c.query('release savepoint sp2'); await c.query('reset role'); await c.query(`select set_config('request.jwt.claims', '', true)`); return { ok: true }; }
    catch (e) { await c.query('rollback to savepoint sp2'); return { ok: false, code: e.code }; }
  };
  chk('tenant_admin LIGA e DESLIGA o próprio aprendizado', (await comoAdmin(`update public.tenants set aprendizado_auto = false where id = $1`, [T.a])).ok === true);
  const proibido = await comoAdmin(`update public.tenants set modelo = 'gpt-4.1' where id = $1`, [T.a]);
  chk('e continua barrado nas colunas da agência (42501)', !proibido.ok && proibido.code === '42501', JSON.stringify(proibido));
} finally {
  await c.query('rollback');
  await c.end();
}

console.log(`\n${ok} passaram, ${falhas.length} falharam\n`);
if (falhas.length) process.exit(1);
