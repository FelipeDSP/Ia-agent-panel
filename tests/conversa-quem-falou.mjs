/**
 * Migração 84 — quem falou na conversa, e o marcador de "já vi" por pessoa.
 *
 * O DEFEITO que isto guarda: a tela rotulava toda saída como "Agente". Nos 30
 * dias anteriores havia 20 falas de ATENDENTE e 14 do SISTEMA sob esse rótulo.
 * Quem abre a conversa para conferir se a IA falou certo não pode confundir a
 * frase de um colega com a da IA — mexeria no prompt por causa de uma frase que
 * o prompt não escreveu.
 *
 * Rollback-first, 84 duas vezes, tudo em transação abortada.
 *
 *   npm run teste:conversa-quem-falou
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(RAIZ, 'supabase', 'migrations');
const leia = (n) => fs.readFileSync(path.join(DIR, n), 'utf8').replace(/\r\n/g, '\n');
const M84 = leia('20261006170000_84_quem_falou_e_o_que_e_novo.sql');
const R84 = leia('20261006170000_84_quem_falou_e_o_que_e_novo_rollback.sql');
const semTx = (s) => s.replace(/^\s*(begin|commit)\s*;\s*$/gim, '');

let ok = 0;
const falhas = [];
const chk = (nome, cond, det = '') => {
  if (cond) { ok++; console.log(`  ok    ${nome}`); }
  else { falhas.push(nome); console.log(`  FALHA ${nome}${det ? ' — ' + det : ''}`); }
};

const url = process.env.SUPABASE_DB_URL ?? fs.readFileSync(path.join(RAIZ, '.env.local'), 'utf8')
  .split(/\r?\n/).find((l) => l.startsWith('SUPABASE_DB_URL='))?.slice('SUPABASE_DB_URL='.length).trim().replace(/^["']|["']$/g, '');
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await c.connect();
await c.query('begin');

const um = async (sql, p = []) => (await c.query(sql, p)).rows[0];
const comoSuper = async (sql, p = []) => {
  await c.query(`select set_config('request.jwt.claims', '{"app_metadata":{"papel":"super_admin"}}', true)`);
  try { return await c.query(sql, p); } finally { await c.query(`select set_config('request.jwt.claims', '', true)`); }
};
const como = async (claims, sql, p = []) => {
  await c.query('savepoint sp');
  try {
    await c.query('set local role authenticated');
    await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
    const r = await c.query(sql, p);
    await c.query('rollback to savepoint sp');
    return { ok: true, rows: r.rows, n: r.rowCount };
  } catch (e) { await c.query('rollback to savepoint sp'); return { ok: false, code: e.code, msg: e.message }; }
};

try {
  console.log('\n== 0. Rollback primeiro, 84 duas vezes ==\n');
  await c.query(semTx(R84));
  chk('pré-84: a função nova não existe',
    (await um(`select to_regprocedure('public.painel_conversa_mensagens(bigint)') f`)).f === null);
  chk('pré-84: a coluna do marcador não existe',
    (await um(`select count(*)::int n from information_schema.columns where table_name='usuarios_painel' and column_name='pedidos_vistos_em'`)).n === 0);

  await c.query(semTx(M84));
  await c.query(semTx(M84));
  chk('a 84 aplica duas vezes seguidas', true);

  console.log('\n== 1. A antiga continua de pé ==\n');
  // O painel NO AR chama `conversa_historico`. Se a 84 a tivesse dropado para
  // "melhorar", a tela quebraria entre a migração e o deploy.
  chk('conversa_historico continua existindo',
    (await um(`select to_regprocedure('public.conversa_historico(bigint)') f`)).f !== null);
  const colsVelha = await um(`select pg_get_function_result(to_regprocedure('public.conversa_historico(bigint)')) r`);
  chk('...com as MESMAS 3 colunas de antes', !/fonte/.test(colsVelha.r), colsVelha.r);

  console.log('\n== 2. A classificação ==\n');
  const t = (await um(`insert into public.tenants (slug, nome) values ($1,'Quem Falou') returning id`,
    [`z-fala-${Date.now()}`])).id;
  const tB = (await um(`insert into public.tenants (slug, nome) values ($1,'Outro') returning id`,
    [`z-fala-b-${Date.now()}`])).id;
  const conv = 991001;

  // CADA MENSAGEM COM SEU INSTANTE. A primeira versão inseriu as seis na mesma
  // transação, e `now()` é o mesmo dentro dela: os seis `criado_em` ficaram
  // idênticos, o desempate virou o `id` (uuid aleatório) e a ordem saiu
  // embaralhada. É a mesma armadilha que o ciclo de aprendizado encontrou em
  // 01/10 — ordenação instável com carimbos empatados.
  let passo = 0;
  const reg = (tenant, conversa, direcao, texto, fonte, ex) =>
    c.query(`insert into public.mensagens_log (tenant_id, conversation_id, direcao, conteudo, fonte_tokens, execucao_id, criado_em)
             values ($1,$2,$3,$4,$5,$6, now() - make_interval(secs => $7))`,
      [tenant, conversa, direcao, texto, fonte, ex, 600 - (passo++) * 10]);

  const marca = Date.now();
  await reg(t, conv, 'entrada', 'oi, tem pao?', null, `a${marca}`);
  await reg(t, conv, 'saida', 'temos sim!', 'openai_usage', `b${marca}`);
  await reg(t, conv, 'saida', 'aqui quem fala e a Maria, do balcao', 'humano', `c${marca}`);
  await reg(t, conv, 'saida', 'nao consigo ouvir audio', 'aviso_midia', `d${marca}`);
  await reg(t, conv, 'saida', 'o endereco e Av. Sao Paulo', 'endereco_retirada', `e${marca}`);
  await reg(t, conv, 'saida', 'resposta sem fonte', null, `f${marca}`);

  // Contraprova do arranjo: os seis instantes TÊM de ser distintos, senão as
  // asserções de ordem abaixo passam ou falham por sorte.
  const distintos = await um(`select count(distinct criado_em)::int n from public.mensagens_log where tenant_id=$1 and conversation_id=$2`, [t, conv]);
  chk('o arranjo deu um instante distinto a cada mensagem', distintos.n === 6, String(distintos.n));

  const idU = crypto.randomUUID();
  await c.query(`insert into auth.users (id, instance_id, aud, role, email, encrypted_password, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
                 values ($1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',$2,'',$3,'{}',now(),now())`,
    [idU, `z-84-${idU}@teste.local`, JSON.stringify({ provider: 'email', providers: ['email'], papel: 'tenant_admin', tenant_id: t })]);
  const claims = { sub: idU, role: 'authenticated', app_metadata: { papel: 'tenant_admin', tenant_id: t } };

  const r = await como(claims, `select conteudo, fonte from public.painel_conversa_mensagens($1) order by criado_em`, [conv]);
  chk('a varredura trouxe as mensagens (lista vazia reprova antes de comparar)', r.ok && r.n === 6, JSON.stringify(r).slice(0, 160));
  const fontes = (r.rows ?? []).map((x) => x.fonte);
  chk('entrada -> cliente', fontes[0] === 'cliente', fontes[0]);
  chk('saída normal -> agente', fontes[1] === 'agente', fontes[1]);
  chk('fonte `humano` -> ATENDENTE (o defeito que isto conserta)', fontes[2] === 'atendente', fontes[2]);
  chk('`aviso_midia` -> sistema', fontes[3] === 'sistema', fontes[3]);
  chk('`endereco_retirada` -> sistema', fontes[4] === 'sistema', fontes[4]);
  chk('saída sem fonte nenhuma -> agente (o padrão não some)', fontes[5] === 'agente', fontes[5]);

  console.log('\n== 3. As duas trancas ==\n');
  // A capacidade: agente sem `ver_conversas` não lê o diálogo.
  const fSemVer = (await um(`insert into public.tenant_funcoes (tenant_id, nome, capacidades) values ($1,'Sem ver','{}') returning id`, [t])).id;
  // O assento ANTES da pessoa: o trigger da 81 recusa o insert quando a conta
  // está em zero, e toda conta nasce em zero. Arranjar o estado é do teste —
  // contar com o default seria afirmar o calendário.
  const idAg = crypto.randomUUID();
  await comoSuper(`update public.tenants set max_agentes = 5 where id = $1`, [t]);
  await c.query(`insert into auth.users (id, instance_id, aud, role, email, encrypted_password, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
                 values ($1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',$2,'',$3,'{}',now(),now())`,
    [idAg, `z-84ag-${idAg}@teste.local`, JSON.stringify({ provider: 'email', providers: ['email'], papel: 'tenant_agente', tenant_id: t })]);
  await comoSuper(`update public.usuarios_painel set funcao_id = $2 where id = $1`, [idAg, fSemVer]);

  const semVer = await como({ sub: idAg, role: 'authenticated', app_metadata: { papel: 'tenant_agente', tenant_id: t } },
    `select * from public.painel_conversa_mensagens($1)`, [conv]);
  chk('agente SEM ver_conversas lê ZERO mensagens', semVer.ok && semVer.n === 0, JSON.stringify(semVer).slice(0, 120));

  // O tenant: ninguém de B lê a conversa de A, nem com o id na mão.
  const idB = crypto.randomUUID();
  await c.query(`insert into auth.users (id, instance_id, aud, role, email, encrypted_password, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
                 values ($1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',$2,'',$3,'{}',now(),now())`,
    [idB, `z-84b-${idB}@teste.local`, JSON.stringify({ provider: 'email', providers: ['email'], papel: 'tenant_admin', tenant_id: tB })]);
  const deB = await como({ sub: idB, role: 'authenticated', app_metadata: { papel: 'tenant_admin', tenant_id: tB } },
    `select * from public.painel_conversa_mensagens($1)`, [conv]);
  chk('admin de OUTRO tenant lê zero (contraprova: A leu 6)', deB.ok && deB.n === 0, JSON.stringify(deB).slice(0, 120));

  console.log('\n== 4. O marcador é da pessoa ==\n');
  const marcar = await como(claims, `update public.usuarios_painel set pedidos_vistos_em = now() where id = $1`, [idU]);
  chk('a pessoa carimba o PRÓPRIO marcador', marcar.ok, JSON.stringify(marcar));
  const papel = await como(claims, `update public.usuarios_painel set papel = 'super_admin' where id = $1`, [idU]);
  chk('...e continua sem poder mexer no próprio papel', !papel.ok && papel.code === '42501', JSON.stringify(papel));
  const alheio = await como({ sub: idAg, role: 'authenticated', app_metadata: { papel: 'tenant_agente', tenant_id: t } },
    `update public.usuarios_painel set pedidos_vistos_em = now() where id = $1`, [idU]);
  chk('agente não carimba o marcador de outra pessoa',
    !alheio.ok || alheio.n === 0, JSON.stringify(alheio));

  console.log('\n== 5. A tela usa a função NOVA ==\n');
  const TELA = fs.readFileSync(path.join(RAIZ, 'src', 'app', '(app)', 'painel', 'conversas', '[conversationId]', 'page.tsx'), 'utf8');
  chk('a tela de conversa chama painel_conversa_mensagens', /painel_conversa_mensagens/.test(TELA));
  chk('...e não a antiga, que não sabe quem falou', !/rpc\('conversa_historico'/.test(TELA));

  console.log('\n== 6. Sabotagem ==\n');
  await c.query('savepoint sab');
  await c.query(`create or replace function public.painel_conversa_mensagens(p_conversation_id bigint)
    returns table(direcao text, conteudo text, criado_em timestamptz, fonte text)
    language sql stable security definer set search_path = public as $sab$
      select m.direcao, m.conteudo, m.criado_em, 'agente'::text
        from public.mensagens_log m
       where m.tenant_id = public.auth_tenant_id() and m.conversation_id = p_conversation_id
       order by m.criado_em, m.id;
    $sab$`);
  const sab = await como(claims, `select fonte from public.painel_conversa_mensagens($1) order by criado_em`, [conv]);
  const fontesSab = (sab.rows ?? []).map((x) => x.fonte);
  chk('S1: com tudo marcado como "agente", a fala do atendente some — e o teste pega',
    fontesSab[2] === 'agente' && fontes[2] === 'atendente', fontesSab.join(','));
  chk('S2: ...e a tranca da capacidade também cai nessa versão (não é só o rótulo)',
    (await como({ sub: idAg, role: 'authenticated', app_metadata: { papel: 'tenant_agente', tenant_id: t } },
      `select * from public.painel_conversa_mensagens($1)`, [conv])).n === 6);
  await c.query('rollback to savepoint sab');
} finally {
  await c.query('rollback');
  await c.end();
}

console.log(`\n${falhas.length ? 'FALHOU' : 'passaram'}: ${ok} ok, ${falhas.length} falhas`);
if (falhas.length) { for (const f of falhas) console.log('  - ' + f); process.exit(1); }
