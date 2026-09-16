#!/usr/bin/env node
/**
 * Migração 62 (o lado do banco da fatia 1 do agente em código) em TRANSAÇÃO
 * ABORTADA contra produção. Nada é gravado.
 *
 * COMEÇA PELO ROLLBACK da própria migração — o banco fica no estado pré-62
 * tendo ela sido aplicada ou não, então este arquivo não afirma o calendário.
 * Depois aplica a 62 DUAS vezes (reexecutável).
 *
 * O que ele mede:
 *   1. aplicar NÃO liga nada: a contagem de tenants em 'codigo' é a mesma
 *      antes e depois; a fila nasce vazia;
 *   2. `agente_runtime` está FORA da lista branca do guard (o texto da função
 *      não a cita) e o update sem claim leva 42501;
 *   3. tabelas: RLS + uma policy cada, `anon` sem grant, ACL `authenticated=r`
 *      e `service_role=r` — lido do `relacl`, não do que a migração escreveu;
 *   4. funções: ACL igual ao da IRMÃ `api_n8n_gerar_cobranca` (comparar com a
 *      irmã, não com a própria expectativa — a lição da 41), e chamada de
 *      verdade como `n8n_agent`;
 *   5. a fila: responder / desistir / adiar / lease vencido / concluir, com
 *      TRÊS tenants e a mesma `conversation_id` em dois deles;
 *   6. o trace: prompt por hash (segundo registro devolve false), passo com
 *      saída de 20 KB truncada e marcada, o bruto do modelo NÃO truncado,
 *      turno fechado uma vez só;
 *   7. a memória: `api_agente_memoria` sobre um log sintético é IDÊNTICA ao
 *      modelo JS (`tests/lib/memoria-modelo.mjs`) nos mesmos casos — inclusive
 *      silêncio 41/39, 25 pares, corte, e a entrada em literal de array;
 *   8. retenção: `api_agente_varrer_passos(30)` apaga só o velho e devolve a
 *      contagem;
 *   9. sabotagens: sem a condição de "mais nova" o `desistir` some; sem o
 *      intervalo o silêncio de 41 min deixa de cortar.
 *
 * Uso: npm run teste:migracao-agente
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { memoriaCodigo } from './lib/memoria-modelo.mjs';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(RAIZ, 'supabase', 'migrations');
const leia = (n) => fs.readFileSync(path.join(DIR, n), 'utf8').replace(/\r\n/g, '\n');
const M62 = leia('20260914200000_62_agente_em_codigo_fatia1.sql');
const R62 = leia('20260914200000_62_agente_em_codigo_fatia1_rollback.sql');
const semTx = (s) => s.replace(/^\s*(begin|commit)\s*;\s*$/gim, '');
const md5 = (t) => crypto.createHash('md5').update(t, 'utf8').digest('hex').slice(0, 12);

let ok = 0;
const falhas = [];
const chk = (nome, cond, det = '') => {
  if (cond) { ok++; console.log(`  OK    ${nome}`); }
  else { falhas.push(nome); console.log(`  FALHA ${nome}${det ? ` — ${det}` : ''}`); }
};

const url = fs.readFileSync(path.join(RAIZ, '.env.local'), 'utf8')
  .split(/\r?\n/).find((l) => l.startsWith('SUPABASE_DB_URL='))
  .slice('SUPABASE_DB_URL='.length).trim().replace(/^["']|["']$/g, '');
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await c.connect();
await c.query('begin');
const um = async (sql, p = []) => (await c.query(sql, p)).rows[0];
const tudo = async (sql, p = []) => (await c.query(sql, p)).rows;
/** Roda algo que DEVE falhar, sem abortar a transação: savepoint em volta. */
const esperaErro = async (fn) => {
  await c.query('savepoint sp_erro');
  try { await fn(); await c.query('release savepoint sp_erro'); return null; }
  catch (e) { await c.query('rollback to savepoint sp_erro'); return e; }
};
const aclFn = async (nome) => (await um(
  `select coalesce(string_agg(coalesce(p.proacl::text,'(NULO)'), ' | ' order by p.oid), '(AUSENTE)') acl
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=$1`, [nome])).acl;

const FUNCOES = ['api_agente_runtime', 'api_agente_par_chatwoot', 'api_agente_enfileirar', 'api_agente_reivindicar', 'api_agente_turno_da_conversa',
  'api_agente_concluir', 'api_agente_descartar_pendentes', 'api_agente_prompt_registrar', 'api_agente_turno_abrir', 'api_agente_passo',
  'api_agente_turno_fechar', 'api_agente_memoria', 'api_agente_memoria_cortar', 'api_agente_memoria_cortar_tenant', 'api_agente_varrer_passos', 'api_agente_mudos', 'agente_texto_entrada'];
const TABELAS = ['agente_fila', 'agente_prompts', 'agente_turnos', 'agente_passos'];

try {
  // =========================================================================
  console.log('\n== 0. Rollback primeiro, depois a 62 duas vezes ==\n');
  // =========================================================================
  // ARRANJO do estado pré-rollback: nenhum tenant em 'codigo' e nenhum turno,
  // porque o rollback aborta de propósito com qualquer um dos dois. Só faz
  // sentido se a coluna/tabela já existirem (banco pós-62).
  const temCol = (await um(`select count(*)::int n from information_schema.columns where table_name='tenants' and column_name='agente_runtime'`)).n === 1;
  // `agente_runtime` é agência-only (guard): o arranjo precisa do claim — e o
  // savepoint isola o claim, porque a §1 abaixo mede o 42501 SEM claim.
  if (temCol) {
    await c.query('savepoint sp_arranjo');
    await c.query(`select set_config('request.jwt.claims', '{"app_metadata":{"papel":"super_admin"}}', true)`);
    await c.query(`update public.tenants set agente_runtime = 'n8n' where agente_runtime = 'codigo'`);
    await c.query(`select set_config('request.jwt.claims', '', true)`);
  }
  if ((await um(`select to_regclass('public.agente_turnos') r`)).r) await c.query(`delete from public.agente_turnos`);
  await c.query(semTx(R62));
  chk('rollback replayado: coluna, tabelas e funções ausentes',
    !(await um(`select to_regclass('public.agente_fila') r`)).r
    && (await um(`select count(*)::int n from information_schema.columns where table_name='tenants' and column_name='agente_runtime'`)).n === 0
    && (await aclFn('api_agente_memoria')) === '(AUSENTE)');

  const emCodigoAntes = 0;   // pós-rollback a coluna não existe: ninguém está em código
  await c.query(semTx(M62));
  await c.query(semTx(M62));
  chk('a 62 aplica DUAS vezes sem erro (reexecutável)', true);
  chk('aplicar NÃO liga ninguém: tenants em \'codigo\' = 0, todos em \'n8n\'',
    (await um(`select count(*)::int n from public.tenants where agente_runtime = 'codigo'`)).n === emCodigoAntes
    && (await um(`select count(*)::int n from public.tenants where agente_runtime <> 'n8n'`)).n === 0);
  chk('a fila nasce vazia', (await um(`select count(*)::int n from public.agente_fila`)).n === 0);

  // =========================================================================
  console.log('\n== 1. agente_runtime é da agência ==\n');
  // =========================================================================
  const guard = (await um(`select pg_get_functiondef('public.tenants_guard_colunas'::regproc) d`)).d;
  chk('a lista branca do guard NÃO cita agente_runtime (coluna fora da lista é imutável para tenant_admin)', !/agente_runtime/.test(guard));
  const T = {};
  for (const s of ['a', 'b', 'c']) {
    T[s] = (await um(`insert into public.tenants (slug, nome) values ($1, $2) returning id`, [`z-teste-ag62-${s}`, `Teste 62 ${s}`])).id;
  }
  {
    await c.query('savepoint sp_guard');
    let err = null;
    try { await c.query(`update public.tenants set agente_runtime = 'codigo' where id = $1`, [T.a]); } catch (e) { err = e; }
    await c.query('rollback to savepoint sp_guard');
    chk('update sem claim de super_admin -> 42501', err?.code === '42501', err ? err.code : '(passou!)');
    await c.query('savepoint sp_super');
    await c.query(`select set_config('request.jwt.claims', '{"app_metadata":{"papel":"super_admin"}}', true)`);
    await c.query(`update public.tenants set agente_runtime = 'codigo' where id = $1`, [T.a]);
    chk('como super_admin a mutação ENTRA e api_agente_runtime devolve \'codigo\'',
      (await um(`select public.api_agente_runtime($1) r`, [T.a])).r === 'codigo');
    let err2 = null;
    try { await c.query(`update public.tenants set agente_runtime = 'lua' where id = $1`, [T.a]); } catch (e) { err2 = e; }
    chk('valor fora do CHECK é recusado (23514)', err2?.code === '23514', err2?.code);
    await c.query('rollback to savepoint sp_super');
  }

  // =========================================================================
  console.log('\n== 2. Tabelas: RLS, policy, ACL lido do relacl ==\n');
  // =========================================================================
  for (const t of TABELAS) {
    const r = await um(`select c.relrowsecurity rls, c.relacl::text acl,
        (select count(*)::int from pg_policy p where p.polrelid = c.oid) pols
      from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname='public' and c.relname=$1`, [t]);
    chk(`${t}: RLS ligada, 1 policy, authenticated=r e service_role=r, SEM anon`,
      r.rls === true && r.pols === 1 && /authenticated=r\/postgres/.test(r.acl) && /service_role=r\/postgres/.test(r.acl) && !/anon=/.test(r.acl) && !/authenticated=arwdDxtm/.test(r.acl), r.acl);
  }
  {
    await c.query('savepoint sp_anon');
    await c.query('set local role anon');
    let err = null;
    try { await c.query('select count(*) from public.agente_passos'); } catch (e) { err = e; }
    await c.query('rollback to savepoint sp_anon');
    chk('`anon` é RECUSADO em agente_passos (42501, no grant — antes da RLS)', err?.code === '42501', err?.code);
  }

  // =========================================================================
  console.log('\n== 3. Funções: ACL igual ao da irmã, e chamada como n8n_agent ==\n');
  // =========================================================================
  const irma = await aclFn('api_n8n_gerar_cobranca');
  for (const f of FUNCOES) {
    chk(`${f}: ACL == ${irma}`, (await aclFn(f)) === irma, await aclFn(f));
  }
  {
    await c.query('savepoint sp_role');
    await c.query('set local role n8n_agent');
    let err = null; let r = null;
    try { r = await um(`select public.api_agente_runtime($1) r`, [T.a]); } catch (e) { err = e; }
    await c.query('rollback to savepoint sp_role');
    chk('n8n_agent chama api_agente_runtime de verdade e recebe \'n8n\'', err === null && r?.r === 'n8n', err?.message);
  }

  // =========================================================================
  console.log('\n== 4. A fila: responder / desistir / adiar / lease / concluir ==\n');
  // =========================================================================
  const enf = async (t, conv, texto, deb) => (await um(`select public.api_agente_enfileirar($1,$2,$3::jsonb,$4) id`, [t, conv, JSON.stringify({ texto }), deb])).id;
  const reiv = async (w, lim = 10, lease = 5) => tudo(`select * from public.api_agente_reivindicar($1,$2,$3)`, [w, lim, lease]);
  const turno = async (t, conv, id, w) => um(`select * from public.api_agente_turno_da_conversa($1,$2,$3,$4)`, [t, conv, id, w]);

  const m1 = await enf(T.a, 1, 'oi', 0);
  const mB = await enf(T.b, 1, 'oi do B', 0);           // MESMA conversation_id, outro tenant
  let lote = await reiv('w1');
  chk('reivindicar (global) devolve as duas vencidas, de tenants diferentes', lote.map((x) => x.id).sort().join() === [m1, mB].sort().join());
  const r1 = await turno(T.a, 1, m1, 'w1');
  chk('responder: só a fila do tenant A na conversa 1 (a de B, mesma conversa, fica fora)',
    r1.decisao === 'responder' && r1.fila_ids.length === 1 && r1.fila_ids[0] === m1 && r1.mensagens[0].texto === 'oi', JSON.stringify(r1));
  {
    const err = await esperaErro(() => turno(T.b, 1, m1, 'w1'));
    chk('tenant B pedindo o turno da fila de A -> 22023 (fila não é desta conversa/tenant)', err?.code === '22023', err?.code);
    const err2 = await esperaErro(() => turno(T.a, 1, m1, 'w-outro'));
    chk('worker que não reivindicou -> 55P03', err2?.code === '55P03', err2?.code);
  }
  chk('concluir marca as linhas e devolve a contagem', (await um(`select public.api_agente_concluir($1,$2,'concluida') n`, [T.a, [m1]])).n === 1
    && (await um(`select estado from public.agente_fila where id=$1`, [m1])).estado === 'concluida');

  // DESISTIR: m2 vence agora, m3 vence em 8 s (mais nova) -> m2 desiste.
  const m2 = await enf(T.a, 2, 'quero um bolo', 0);
  const m3 = await enf(T.a, 2, 'de cenoura', 8);
  lote = await reiv('w1');
  chk('só m2 está vencida (m3 tem 8 s de debounce pela frente)', lote.length === 1 && lote[0].id === m2);
  const r2 = await turno(T.a, 2, m2, 'w1');
  chk('DESISTIR: há mensagem mais nova pendente — m2 volta a pendente', r2.decisao === 'desistir'
    && (await um(`select estado, reivindicada_por p from public.agente_fila where id=$1`, [m2])).estado === 'pendente');
  // ARRANJO: o tempo passa — m3 vence.
  await c.query(`update public.agente_fila set executar_em = now() - interval '1 second' where id = $1`, [m3]);
  lote = await reiv('w1');
  chk('agora as duas vencem e são reivindicadas', lote.length === 2);
  // m3 (mais nova) foi reivindicada no MESMO lote por w1: m2 desiste — a mais
  // nova responde por todas. ADIAR é só quando o outro turno é de OUTRO worker:
  await c.query(`update public.agente_fila set reivindicada_por = 'w-outro' where id = $1`, [m3]);
  const r2b = await turno(T.a, 2, m2, 'w1');
  chk('m2 com m3 processando em OUTRO worker: ADIAR', r2b.decisao === 'adiar', r2b.decisao);
  await c.query(`update public.agente_fila set reivindicada_por = 'w1', estado = 'processando', reivindicada_em = now() where id = $1`, [m3]);
  await c.query(`update public.agente_fila set estado = 'processando', reivindicada_por = 'w1', reivindicada_em = now() where id = $1`, [m2]);
  const r2c = await turno(T.a, 2, m2, 'w1');
  chk('m2 com m3 reivindicada pelo MESMO worker: DESISTIR (a mais nova varre)', r2c.decisao === 'desistir', r2c.decisao);
  const r3 = await turno(T.a, 2, m3, 'w1');
  chk('RESPONDER pela mais nova, com as DUAS mensagens em ordem de chegada',
    r3.decisao === 'responder' && r3.fila_ids.length === 2 && r3.mensagens.map((m) => m.texto).join('|') === 'quero um bolo|de cenoura', JSON.stringify(r3));

  // LEASE vencido: worker morreu com m3 processando.
  await c.query(`update public.agente_fila set reivindicada_em = now() - interval '6 minutes' where id = any($1)`, [r3.fila_ids]);
  lote = await reiv('w2');
  chk('lease vencido: outro worker reivindica, com tentativas + 1',
    lote.length === 2 && lote.every((x) => x.reivindicada_por === 'w2' && x.tentativas === 1));
  chk('concluir só mexe em linhas processando do próprio tenant (B tentando as de A: 0)',
    (await um(`select public.api_agente_concluir($1,$2,'concluida') n`, [T.b, r3.fila_ids])).n === 0);

  // HUMANO ASSUMIU: as pendentes da conversa viram descartadas, em silêncio.
  const m5 = await enf(T.a, 3, 'oi', 8); const m6 = await enf(T.a, 3, 'tem?', 8);
  const mB3 = await enf(T.b, 3, 'oi do B', 8);
  chk('descartar_pendentes: as duas de A na conversa 3 viram descartada com o motivo; a de B fica',
    (await um(`select public.api_agente_descartar_pendentes($1, 3, 'humano_assumiu') n`, [T.a])).n === 2
    && (await tudo(`select estado, erro from public.agente_fila where id = any($1)`, [[m5, m6]])).every((x) => x.estado === 'descartada' && x.erro === 'humano_assumiu')
    && (await um(`select estado from public.agente_fila where id=$1`, [mB3])).estado === 'pendente');

  // =========================================================================
  console.log('\n== 5. O trace ==\n');
  // =========================================================================
  const H = 'sha256:' + 'a'.repeat(20);
  chk('prompt_registrar: primeira vez true, segunda false (mesmo hash)',
    (await um(`select public.api_agente_prompt_registrar($1,$2,'texto','v1') r`, [T.a, H])).r === true
    && (await um(`select public.api_agente_prompt_registrar($1,$2,'texto','v1') r`, [T.a, H])).r === false);
  chk('  ...e o mesmo hash em OUTRO tenant é linha própria', (await um(`select public.api_agente_prompt_registrar($1,$2,'texto','v1') r`, [T.b, H])).r === true);
  const turnoId = (await um(`select public.api_agente_turno_abrir($1, 2, $2, 'processar', 'vendas', 'gpt-x', $3) id`, [T.a, m3, H])).id;
  const grande = JSON.stringify({ texto: 'x'.repeat(20000) });
  await c.query(`select public.api_agente_passo($1,$2,1,'tool','consultar_catalogo','{"q":"bolo"}'::jsonb,$3::jsonb)`, [T.a, turnoId, grande]);
  await c.query(`select public.api_agente_passo($1,$2,2,'modelo','openai',null,$3::jsonb)`, [T.a, turnoId, grande]);
  const passos = await tudo(`select ordem, tipo, saida from public.agente_passos where turno_id=$1 order by ordem`, [turnoId]);
  chk('saída de tool com 20 KB é TRUNCADA e marcada (_truncado)', passos[0].saida._truncado === true && passos[0].saida.texto.length === 16384);
  chk('o bruto do modelo NÃO é truncado', passos[1].saida._truncado === undefined && passos[1].saida.texto.length === 20000);
  {
    const err = await esperaErro(() => c.query(`select public.api_agente_passo($1,$2,1,'tool','x')`, [T.a, turnoId]));
    chk('ordem repetida no mesmo turno -> 23505', err?.code === '23505', err?.code);
    const err2 = await esperaErro(() => c.query(`select public.api_agente_passo($1,$2,3,'tool','x')`, [T.b, turnoId]));
    chk('tenant B escrevendo passo no turno de A -> 22023', err2?.code === '22023', err2?.code);
  }
  chk('turno_fechar: true na primeira, false na segunda (já fechado)',
    (await um(`select public.api_agente_turno_fechar($1,$2,'ok',100,20,1,1,'passou') r`, [T.a, turnoId])).r === true
    && (await um(`select public.api_agente_turno_fechar($1,$2,'ok') r`, [T.a, turnoId])).r === false);

  // =========================================================================
  console.log('\n== 6. A memória: a função == o modelo JS, no mesmo log ==\n');
  // =========================================================================
  // O log é sintético e inserido com `criado_em` explícito. O "agora" do
  // modelo é o now() da transação (constante), lido do banco.
  const agora = (await um(`select now() t`)).t.getTime();
  const min = (n) => n * 60000;
  const CONV = 9;
  let ordemLog = 0;
  const logar = async (t, conv, direcao, conteudo, delta) => {
    ordemLog++;
    await c.query(`insert into public.mensagens_log (tenant_id, conversation_id, direcao, conteudo, criado_em) values ($1,$2,$3,$4, now() - make_interval(secs => $5))`,
      [t, conv, direcao, conteudo, delta / 1000]);
    return { direcao, conteudo, criado_em: agora - delta };
  };
  const turnoLog = async (t, conv, deltaMin, cliente, agente) => [
    await logar(t, conv, 'entrada', cliente, min(deltaMin)),
    await logar(t, conv, 'saida', agente, min(deltaMin)),
  ];
  const daFuncao = async (t, conv) => (await tudo(`select papel, texto from public.api_agente_memoria($1,$2)`, [t, conv])).map((r) => ({ papel: r.papel, texto: r.texto }));
  const doModelo = (log, corteEm = null) => memoriaCodigo(log, { agora, corteEm }).map((m) => ({ papel: m.papel, texto: m.texto }));
  const igual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  // caso 1: simples (2 turnos, há 5 e 3 min)
  const log1 = [...await turnoLog(T.a, CONV, 5, 'oi', 'Oi! Como posso ajudar?'), ...await turnoLog(T.a, CONV, 3, 'tem bolo?', 'Temos bolo de cenoura.')];
  chk('simples: função == modelo (4 mensagens)', igual(await daFuncao(T.a, CONV), doModelo(log1)) && (await daFuncao(T.a, CONV)).length === 4);
  // caso 2: silêncio de 41 min antes do turno atual -> só o turno novo
  const log2 = [...await turnoLog(T.a, 10, 50, 'antigo', 'Resposta antiga'), ...await turnoLog(T.a, 10, 9, 'voltei', 'Bem-vindo')];
  const f2 = await daFuncao(T.a, 10);
  chk('silêncio de 41 min: função == modelo, e só o turno novo sobrevive', igual(f2, doModelo(log2)) && f2.length === 2 && f2[0].texto === 'voltei', JSON.stringify(f2));
  // caso 3: silêncio de 39 min -> lembra
  const log3 = [...await turnoLog(T.a, 11, 48, 'antigo', 'Resposta antiga'), ...await turnoLog(T.a, 11, 9, 'voltei', 'Bem-vindo')];
  chk('silêncio de 39 min: função == modelo, 4 mensagens', igual(await daFuncao(T.a, 11), doModelo(log3)) && (await daFuncao(T.a, 11)).length === 4);
  // caso 4: último turno há 45 min, nada novo -> vazia
  const log4 = await turnoLog(T.a, 12, 45, 'oi', 'Oi');
  chk('último turno há 45 min: VAZIA nos dois', igual(await daFuncao(T.a, 12), doModelo(log4)) && (await daFuncao(T.a, 12)).length === 0);
  // caso 5: 25 pares -> últimos 20 pares
  const log5 = [];
  for (let i = 0; i < 25; i++) log5.push(...await turnoLog(T.a, 13, 30 - i, `pergunta ${i}`, `resposta ${i}`));
  const f5 = await daFuncao(T.a, 13);
  chk('25 pares: função == modelo, 40 mensagens começando na pergunta 5', igual(f5, doModelo(log5)) && f5.length === 40 && f5[0].texto === 'pergunta 5', `${f5.length} ${f5[0]?.texto}`);
  // caso 6: corte pelo painel
  const log6 = [...await turnoLog(T.a, 14, 6, 'oi', 'Oi'), ...await turnoLog(T.a, 14, 4, 'quero x', 'Anotado')];
  await c.query(`select public.api_agente_memoria_cortar($1, 14)`, [T.a]);
  await c.query(`update public.conversas set memoria_cortada_em = now() - interval '5 minutes' where tenant_id=$1 and conversation_id=14`, [T.a]);
  const f6 = await daFuncao(T.a, 14);
  chk('corte há 5 min: função == modelo, só o turno de 4 min atrás', igual(f6, doModelo(log6, agora - min(5))) && f6.length === 2 && f6[0].texto === 'quero x', JSON.stringify(f6));
  // o botão do painel: escopo 'todas' corta todas as conversas do tenant; B intacto.
  // Em savepoint, porque o corte mudaria os casos seguintes (é o que ele faz).
  {
    await c.query('savepoint sp_cortar');
    await c.query(`select public.api_n8n_conversa_sync($1, 9, 'x', null)`, [T.a]);
    await c.query(`select public.api_n8n_conversa_sync($1, 10, 'x', null)`, [T.a]);
    await c.query(`select public.api_n8n_conversa_sync($1, 9, 'y', null)`, [T.b]);
    chk('memoria_cortar_tenant(todas) corta as 3 conversas de A e a de B fica sem corte',
      Number((await um(`select public.api_agente_memoria_cortar_tenant($1, null) n`, [T.a])).n) === 3
      && (await um(`select count(*)::int n from public.conversas where tenant_id=$1 and memoria_cortada_em is not null`, [T.b])).n === 0);
    chk('  ...e com o corte, a memória da conversa 10 fica VAZIA', (await daFuncao(T.a, 10)).length === 0);
    chk('memoria_cortar_tenant([9,10]) devolve 2', Number((await um(`select public.api_agente_memoria_cortar_tenant($1, $2::bigint[]) n`, [T.a, [9, 10]])).n) === 2);
    await c.query('rollback to savepoint sp_cortar');
  }
  // caso 7: entrada em literal de array (o log do n8n de hoje)
  await logar(T.a, 15, 'entrada', '{oi,"quero 2 bolos"}', min(2));
  await logar(T.a, 15, 'saida', 'Anotei 2 bolos', min(2));
  const f7 = await daFuncao(T.a, 15);
  chk('entrada como literal de array `{oi,"quero 2 bolos"}` vira duas linhas de texto', f7[0].texto === 'oi\nquero 2 bolos', JSON.stringify(f7[0]));
  chk('texto que não é array passa cru pelo conversor', (await um(`select public.agente_texto_entrada('oi {não} array') t`)).t === 'oi {não} array');
  // isolamento: tenant B com a MESMA conversa 9 não vê nada de A
  chk('tenant B, mesma conversation_id 9: memória vazia (não vê o log de A)', (await daFuncao(T.b, CONV)).length === 0);
  void ordemLog;

  // =========================================================================
  console.log('\n== 7. Retenção ==\n');
  // =========================================================================
  await c.query(`update public.agente_passos set criado_em = now() - interval '31 days' where turno_id=$1 and ordem=1`, [turnoId]);
  chk('varrer(30) apaga o passo de 31 dias e devolve 1; o de hoje fica',
    (await um(`select public.api_agente_varrer_passos(30) n`)).n === 1
    && (await um(`select count(*)::int n from public.agente_passos where turno_id=$1`, [turnoId])).n === 1);

  // ALARME DE AGENTE MUDO: só tenant em 'codigo', só fila parada há mais de N min.
  {
    await c.query('savepoint sp_mudo');
    await c.query(`select set_config('request.jwt.claims', '{"app_metadata":{"papel":"super_admin"}}', true)`);
    await c.query(`update public.tenants set agente_runtime = 'codigo' where id = $1`, [T.c]);
    const mC = await enf(T.c, 7, 'oi', 0);
    chk('mudos(10): fila recém-criada NÃO acusa', (await tudo(`select * from public.api_agente_mudos(10)`)).length === 0);
    await c.query(`update public.agente_fila set criado_em = now() - interval '11 minutes' where id = $1`, [mC]);
    const mudos = await tudo(`select * from public.api_agente_mudos(10)`);
    chk('mudos(10): fila pendente há 11 min em tenant \'codigo\' ACUSA, com os minutos', mudos.length === 1 && mudos[0].tenant_id === T.c && Number(mudos[0].minutos_mudo) >= 11, JSON.stringify(mudos));
    await c.query(`update public.tenants set agente_runtime = 'n8n' where id = $1`, [T.c]);
    chk('  ...e o mesmo tenant em \'n8n\' NÃO acusa (a fila dele não é nossa)', (await tudo(`select * from public.api_agente_mudos(10)`)).length === 0);
    await c.query('rollback to savepoint sp_mudo');
  }

  // =========================================================================
  console.log('\n== 8. Rollback aborta com tenant em código ou turno gravado ==\n');
  // =========================================================================
  {
    await c.query('savepoint sp_rb');
    let err = null;
    try { await c.query(semTx(R62)); } catch (e) { err = e; }
    await c.query('rollback to savepoint sp_rb');
    chk('com turnos gravados, o rollback ABORTA com a mensagem própria', /turno\(s\) em agente_turnos/.test(err?.message ?? ''), err?.message?.slice(0, 80));
  }

  // =========================================================================
  console.log('\n== 9. SABOTAGEM (na própria migração, em savepoint) ==\n');
  // =========================================================================
  {
    const alvo = /^(\s+and f\.seq > v_minha\.seq)$/m;
    const n = (M62.match(new RegExp(alvo.source, 'gm')) ?? []).length;
    if (n !== 1) chk('S1 localizou o alvo', false, `${n}x`);
    else {
      const mut = M62.replace(alvo, '$1 and false');
      console.log(`     [mutou "desistir nunca": md5 ${md5(M62)} -> ${md5(mut)}]`);
      await c.query('savepoint sp_s1');
      await c.query(semTx(mut));
      const a = await enf(T.c, 1, 'a', 0); const b = await enf(T.c, 1, 'b', 8);
      await reiv('w9');
      const r = await turno(T.c, 1, a, 'w9');
      chk('S1: sem a condição, a mensagem mais velha RESPONDE em vez de desistir (a asserção de desistir pegaria)', r.decisao === 'responder', r.decisao);
      void b;
      await c.query('rollback to savepoint sp_s1');
    }
    const alvo2 = 'select max(t) from lacunas where lacuna > v_silencio)';
    const n2 = M62.split(alvo2).length - 1;
    if (n2 !== 1) chk('S2 localizou o alvo', false, `${n2}x`);
    else {
      const mut = M62.split(alvo2).join('select max(t) from lacunas where lacuna > v_silencio * 100)');
      console.log(`     [mutou "intervalo x100": md5 ${md5(M62)} -> ${md5(mut)}]`);
      await c.query('savepoint sp_s2');
      await c.query(semTx(mut));
      const f = await daFuncao(T.a, 10);
      chk('S2: sem o intervalo, o silêncio de 41 min NÃO corta (4 mensagens) — o caso 2 pegaria', f.length === 4, String(f.length));
      await c.query('rollback to savepoint sp_s2');
    }
  }
} catch (e) {
  falhas.push('exceção');
  console.log(`\n  EXCEÇÃO: ${e.code ?? ''} ${e.message}`);
} finally {
  await c.query('rollback');
  await c.end();
}

console.log(`\n${'-'.repeat(62)}`);
console.log(`  ${ok} passaram, ${falhas.length} falharam`);
if (falhas.length) { for (const f of falhas) console.log(`    - ${f}`); process.exit(1); }
