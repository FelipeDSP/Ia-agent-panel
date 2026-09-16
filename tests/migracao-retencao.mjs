/**
 * Migração 67 — a retenção de dados (docs/POLITICA-RETENCAO.md).
 *
 * Rollback-first, 67 duas vezes, ACL. Três tenants com linhas de datas
 * ARRANJADAS (texto velho e novo, turno velho e novo, conversa parada e
 * ativa, pedido velho) e a função rodando de verdade na transação:
 *   - texto some com > 45 dias e a LINHA fica (a contagem sobrevive);
 *   - linha some com > 400 dias; texto novo fica intacto;
 *   - turno velho some (passos por cascade); aberto fica; fila velha some;
 *   - identidade da conversa parada some; a ativa fica; a linha fica;
 *   - pedidos/cobranças de 2 anos NÃO são tocados;
 *   - contagem < texto é recusado (apagaria linha do mês corrente).
 * Sabotagem: sem o `status <> 'aberto'`, o turno aberto seria apagado.
 *
 *   npm run teste:migracao-retencao
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(RAIZ, 'supabase', 'migrations');
const leia = (n) => fs.readFileSync(path.join(DIR, n), 'utf8').replace(/\r\n/g, '\n');
const M67 = leia('20260916230000_67_retencao_de_dados.sql');
const R67 = leia('20260916230000_67_retencao_de_dados_rollback.sql');
const semTx = (s) => s.replace(/^\s*(begin|commit)\s*;\s*$/gim, '');
const md5 = (t) => crypto.createHash('md5').update(t, 'utf8').digest('hex').slice(0, 12);

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
const esperaErro = async (fn) => {
  await c.query('savepoint sp_erro');
  try { await fn(); await c.query('release savepoint sp_erro'); return null; }
  catch (e) { await c.query('rollback to savepoint sp_erro'); return e; }
};
const aclFn = async (nome) => (await um(
  `select coalesce(string_agg(coalesce(p.proacl::text,'(NULO)'), ' | ' order by p.oid), '(AUSENTE)') acl
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=$1`, [nome])).acl;
const rodar = async () => Object.fromEntries((await tudo(`select * from public.api_agente_retencao(45, 45, 400, 180)`)).map((r) => [r.alvo, Number(r.linhas)]));

try {
  console.log('\n== 0. Rollback primeiro, 67 duas vezes, ACL ==\n');
  await c.query(semTx(R67));
  chk('pré-67: função ausente', (await aclFn('api_agente_retencao')) === '(AUSENTE)');
  await c.query(semTx(M67)); await c.query(semTx(M67));
  const irma = await aclFn('api_agente_varrer_passos');
  chk('a 67 aplica duas vezes; ACL == irmã (api_agente_varrer_passos)', (await aclFn('api_agente_retencao')) === irma, await aclFn('api_agente_retencao'));

  console.log('\n== 1. Arranjo: três tenants, datas velhas e novas ==\n');
  const T = {};
  for (const s of ['a', 'b', 'c']) T[s] = (await um(`insert into public.tenants (slug, nome) values ($1, $2) returning id`, [`z-teste-67-${s}`, `Teste 67 ${s}`])).id;
  const msg = (t, conv, dias, texto) => um(`insert into public.mensagens_log (tenant_id, conversation_id, direcao, conteudo, tokens_entrada, tokens_saida, portao, criado_em) values ($1, $2, 'saida', $3, 100, 10, '{"veredito":"passou"}', now() - make_interval(days => $4)) returning id`, [t, conv, texto, dias]);
  const velha = await msg(T.a, 1, 50, 'texto velho A');       // > 45: texto some
  const nova = await msg(T.a, 1, 10, 'texto novo A');         // fica
  const antiga = await msg(T.a, 1, 410, 'texto antiquíssimo'); // > 400: linha some
  const velhaB = await msg(T.b, 1, 50, 'texto velho B');      // outro tenant: mesmo corte
  await c.query(`insert into public.conversas (tenant_id, conversation_id, contact_name, phone, atualizado_em) values ($1, 1, 'Fulano', '5511', now() - interval '200 days'), ($2, 1, 'Beltrano', '5522', now() - interval '10 days'), ($3, 1, 'Sicrano', '5533', now() - interval '200 days')`, [T.a, T.b, T.c]);
  const turnoVelho = await um(`insert into public.agente_turnos (tenant_id, conversation_id, status, iniciado_em, concluido_em) values ($1, 1, 'ok', now() - interval '60 days', now() - interval '60 days') returning id`, [T.a]);
  await c.query(`insert into public.agente_passos (tenant_id, turno_id, ordem, tipo, nome, criado_em) values ($1, $2, 1, 'entrada', 'x', now() - interval '60 days')`, [T.a, turnoVelho.id]);
  const turnoAberto = await um(`insert into public.agente_turnos (tenant_id, conversation_id, status, iniciado_em) values ($1, 1, 'aberto', now() - interval '60 days') returning id`, [T.a]);
  const turnoNovo = await um(`insert into public.agente_turnos (tenant_id, conversation_id, status, iniciado_em, concluido_em) values ($1, 1, 'ok', now() - interval '2 days', now() - interval '2 days') returning id`, [T.b]);
  const filaVelha = await um(`insert into public.agente_fila (tenant_id, conversation_id, mensagem, executar_em, estado, criado_em) values ($1, 1, '{}', now(), 'concluida', now() - interval '60 days') returning id`, [T.a]);
  const filaPendente = await um(`insert into public.agente_fila (tenant_id, conversation_id, mensagem, executar_em, estado, criado_em) values ($1, 1, '{}', now(), 'pendente', now() - interval '60 days') returning id`, [T.a]);
  const pedido = await um(`insert into public.pedidos (tenant_id, conversation_id, numero, status, criado_em) values ($1, 1, 6701, 'pago', now() - interval '700 days') returning id`, [T.c]);
  const retratoFinanceiro = md5(JSON.stringify(await tudo(`select id, status, criado_em from public.pedidos where tenant_id=$1 order by id`, [T.c])));

  console.log('\n== 2. Rodar ==\n');
  const r = await rodar();
  chk('contou: texto 2 (A velha + B velha), linhas 1 (antiquíssima), turnos 1, fila 1, identidade 2 (A e C paradas)',
    r['mensagens_log.texto'] >= 2 && r['mensagens_log.linhas'] >= 1 && r['agente_turnos'] >= 1 && r['agente_fila'] >= 1 && r['conversas.identidade'] >= 2, JSON.stringify(r));
  const v = await um(`select conteudo, portao, tokens_entrada from public.mensagens_log where id=$1`, [velha.id]);
  chk('texto velho: conteudo e portao NULOS, a linha FICA com os tokens (100)', v && v.conteudo === null && v.portao === null && v.tokens_entrada === 100, JSON.stringify(v));
  chk('texto novo intacto', (await um(`select conteudo from public.mensagens_log where id=$1`, [nova.id])).conteudo === 'texto novo A');
  chk('linha antiquíssima apagada', (await um(`select count(*)::int n from public.mensagens_log where id=$1`, [antiga.id])).n === 0);
  chk('o corte é global: o texto velho de B também foi', (await um(`select conteudo from public.mensagens_log where id=$1`, [velhaB.id])).conteudo === null);
  chk('turno velho apagado (e o passo dele por cascade); aberto FICA; novo fica',
    (await um(`select count(*)::int n from public.agente_turnos where id = any($1::uuid[])`, [[turnoVelho.id]])).n === 0
    && (await um(`select count(*)::int n from public.agente_passos where turno_id=$1`, [turnoVelho.id])).n === 0
    && (await um(`select count(*)::int n from public.agente_turnos where id = any($1::uuid[])`, [[turnoAberto.id, turnoNovo.id]])).n === 2);
  chk('fila concluída velha apagada; pendente velha FICA (é o alarme de mudo que trata)',
    (await um(`select count(*)::int n from public.agente_fila where id=$1`, [filaVelha.id])).n === 0 && (await um(`select count(*)::int n from public.agente_fila where id=$1`, [filaPendente.id])).n === 1);
  const convs = await tudo(`select tenant_id, contact_name, phone from public.conversas where conversation_id=1 and tenant_id = any($1::uuid[])`, [[T.a, T.b, T.c]]);
  chk('identidade: A e C (paradas há 200 d) anonimizadas, B (ativa) intacta, as três linhas FICAM',
    convs.length === 3 && convs.filter((x) => x.contact_name === null && x.phone === null).length === 2 && convs.some((x) => x.tenant_id === T.b && x.contact_name === 'Beltrano'), JSON.stringify(convs));
  chk('financeiro intacto (pedido de 700 dias: retrato igual)', md5(JSON.stringify(await tudo(`select id, status, criado_em from public.pedidos where tenant_id=$1 order by id`, [T.c]))) === retratoFinanceiro && pedido.id);
  const r2 = await rodar();
  chk('segunda passada: zero em tudo (idempotente)', Object.values(r2).every((n) => n === 0), JSON.stringify(r2));
  const e = await esperaErro(() => c.query(`select * from public.api_agente_retencao(45, 45, 30, 180)`));
  chk('contagem (30) menor que texto (45) -> 22023', e?.code === '22023', e?.code);
  {
    await c.query('savepoint sp_role'); await c.query('set local role n8n_agent');
    let err = null;
    try { await c.query(`select * from public.api_agente_retencao(45, 45, 400, 180)`); } catch (x) { err = x; }
    await c.query('rollback to savepoint sp_role');
    chk('n8n_agent chama de verdade', err === null, err?.message);
  }

  console.log('\n== 3. SABOTAGEM ==\n');
  {
    await c.query('savepoint sp_sab');
    const mut = M67.replace("where t.iniciado_em < now() - v_turnos and t.status <> 'aberto';", "where t.iniciado_em < now() - v_turnos;");
    chk('a mutação entrou (md5)', md5(mut) !== md5(M67));
    await c.query(semTx(mut));
    await rodar();
    chk('sem o `status <> aberto`, o turno ABERTO é apagado (a asserção 2 pegaria)', (await um(`select count(*)::int n from public.agente_turnos where id=$1`, [turnoAberto.id])).n === 0);
    await c.query('rollback to savepoint sp_sab');
  }
} catch (e) {
  falhas.push(`EXCEÇÃO: ${e.message}`); console.log(`  EXCEÇÃO ${e.message}`);
} finally {
  await c.query('rollback'); await c.end();
}
console.log(`\n${ok} passaram, ${falhas.length} falharam\n`);
if (falhas.length) process.exit(1);
