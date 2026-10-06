/**
 * Migração 80 — funções por conta (equipe do cliente).
 *
 * Rollback-first, 80 duas vezes, tudo numa transação que termina em rollback.
 * As propriedades estão em `docs/DESENHO-USUARIOS-POR-CONTA.md` §10.
 *
 * O QUE ESTE TESTE EXISTE PARA PEGAR, e é o motivo de ele ser longo: a
 * permissão tem TRÊS portas independentes e elas falham de jeitos diferentes.
 *
 *   1. a policy  — nega o PostgREST e o supabase-js;
 *   2. a função `SECURITY DEFINER` — roda como `postgres`, que tem BYPASSRLS,
 *      então nenhuma policy a vê passar. `painel_marcar_pedido` ESCREVE;
 *   3. a tela — esconde o botão, e não impede ninguém de chamar direto.
 *
 * Esconder o botão sem fechar 1 e 2 produz exatamente a falsa sensação de
 * controle que o CLAUDE.md descreve na seção de superfície de tool. Então as
 * duas primeiras são medidas aqui, com claims reais, e a terceira no painel.
 *
 * E as listas saem do CATÁLOGO (`pg_policy`, `pg_proc`), nunca escritas à mão:
 * tabela nova com `tenant_id` e função nova `SECURITY DEFINER` entram sozinhas
 * na varredura, como em `teste:grants-n8n`.
 *
 *   npm run teste:funcoes-por-conta
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(RAIZ, 'supabase', 'migrations');
const leia = (n) => fs.readFileSync(path.join(DIR, n), 'utf8').replace(/\r\n/g, '\n');
const M80 = leia('20261006120000_80_funcoes_por_conta.sql');
const R80 = leia('20261006120000_80_funcoes_por_conta_rollback.sql');
const semTx = (s) => s.replace(/^\s*(begin|commit)\s*;\s*$/gim, '');

const { CHAVES_CAPACIDADES } = await import(new URL('../src/lib/usuarios/capacidades.ts', import.meta.url).href);

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

/** Roda `sql` como `authenticated` com estes claims, num savepoint. */
const como = async (claims, sql, p = []) => {
  await c.query('savepoint sp');
  try {
    await c.query('set local role authenticated');
    await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
    const r = await c.query(sql, p);
    await c.query('rollback to savepoint sp');
    return { ok: true, linhas: r.rowCount, rows: r.rows };
  } catch (e) {
    await c.query('rollback to savepoint sp');
    return { ok: false, code: e.code, msg: e.message };
  }
};
/** Igual, mas MANTÉM o efeito (sem rollback do savepoint). */
const comoFirme = async (claims, sql, p = []) => {
  await c.query('set local role authenticated');
  await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
  try {
    const r = await c.query(sql, p);
    await c.query('reset role');
    return { ok: true, linhas: r.rowCount, rows: r.rows };
  } catch (e) {
    await c.query('reset role');
    return { ok: false, code: e.code, msg: e.message };
  }
};

try {
  console.log('\n== 0. Rollback primeiro, depois a 80 duas vezes ==\n');

  await c.query(semTx(R80));
  const prePapel = await um(`select pg_get_constraintdef(oid) d from pg_constraint
    where conrelid='public.usuarios_painel'::regclass and conname='usuarios_painel_papel_check'`);
  chk('pré-80: o CHECK de papel não conhece tenant_agente', !/tenant_agente/.test(prePapel.d), prePapel.d);
  chk('pré-80: tenant_funcoes não existe',
    (await um(`select to_regclass('public.tenant_funcoes') t`)).t === null);

  await c.query(semTx(M80));
  await c.query(semTx(M80)); // idempotente: aplicar duas vezes não pode estourar
  chk('a 80 aplica duas vezes seguidas', true);
  chk('tenant_funcoes existe',
    (await um(`select to_regclass('public.tenant_funcoes') t`)).t !== null);
  chk('RLS ligada em tenant_funcoes',
    (await um(`select relrowsecurity r from pg_class where oid='public.tenant_funcoes'::regclass`)).r === true);

  console.log('\n== 1. O par derivado: a lista do banco é a lista do código ==\n');

  const doBanco = (await um(`select public.capacidades_conhecidas() c`)).c;
  chk('a varredura ACHOU capacidades (lista vazia reprova antes de comparar)',
    Array.isArray(doBanco) && doBanco.length > 0, JSON.stringify(doBanco));
  chk('o código tem a MESMA lista do banco (par derivado não diverge)',
    JSON.stringify([...doBanco].sort()) === JSON.stringify([...CHAVES_CAPACIDADES].sort()),
    `banco=${doBanco} codigo=${CHAVES_CAPACIDADES}`);

  console.log('\n== 2. Nenhuma porta ficou aberta (listas do CATÁLOGO) ==\n');

  // 2a. Nenhuma tabela escopada por tenant ficou com policy de ESCRITA que
  //     só olha o tenant, sem capacidade nem admin. A lista sai de pg_policy.
  const escritas = (await c.query(`
    select cl.relname tabela, p.polname,
           case p.polcmd when 'a' then 'insert' when 'w' then 'update' when 'd' then 'delete' when '*' then 'all' end cmd,
           coalesce(pg_get_expr(p.polqual, p.polrelid),'') || ' ' || coalesce(pg_get_expr(p.polwithcheck, p.polrelid),'') expr
      from pg_policy p
      join pg_class cl on cl.oid = p.polrelid
      join pg_namespace n on n.oid = cl.relnamespace
     where n.nspname='public' and p.polcmd in ('a','w','d','*')
       and exists (select 1 from information_schema.columns ic
                    where ic.table_schema='public' and ic.table_name=cl.relname and ic.column_name='tenant_id')
     order by 1,2`)).rows;
  chk('a varredura ACHOU policies de escrita', escritas.length > 0, String(escritas.length));

  // A regra sai da FORMA da expressão, não de uma lista de exceções escrita à
  // mão — lista à mão é a auto-confirmação que o CLAUDE.md descreve nos grants:
  // eu conferiria contra o que eu mesmo esperava. Uma policy de escrita é
  // aceitável quando:
  //   (a) exige capacidade ou admin do tenant; ou
  //   (b) é EXCLUSIVA da agência — fala de super_admin e não abre para o
  //       tenant. Essa é estritamente mais apertada, então não é frouxidão.
  const soDaAgencia = (e) => /auth_is_super_admin/.test(e) && !/auth_tenant_id/.test(e);
  const frouxas = escritas.filter((r) => !/auth_pode\(|auth_e_admin\(/.test(r.expr) && !soDaAgencia(r.expr));
  chk('toda policy de escrita exige capacidade, admin, ou é da agência', frouxas.length === 0,
    frouxas.map((r) => `${r.tabela}.${r.polname}`).join(', '));

  // 2b. Toda SECURITY DEFINER chamável pelo cliente logado tem checagem.
  const secdef = (await c.query(`
    select p.proname, pg_get_functiondef(p.oid) d
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname='public' and p.prosecdef
       and has_function_privilege('authenticated', p.oid, 'execute')
     order by 1`)).rows;
  chk('a varredura ACHOU funções SECURITY DEFINER do cliente', secdef.length > 0, String(secdef.length));
  // `auth_*` são as próprias funções de permissão; `agendar_podcast` não é
  // deste produto. Exceções declaradas, não inferidas.
  const FORA = ['agendar_podcast', 'auth_capacidades', 'auth_papel', 'handle_novo_usuario'];
  const semChecagem = secdef
    .filter((r) => !FORA.includes(r.proname))
    .filter((r) => !/auth_pode\(|auth_capacidades\(|auth_is_super_admin\(|auth_tenant_id\(/.test(r.d));
  chk('toda SECURITY DEFINER do cliente consulta permissão por dentro', semChecagem.length === 0,
    semChecagem.map((r) => r.proname).join(', '));

  console.log('\n== 3. Comportamento, com claims de gente de verdade ==\n');

  // Dois tenants: um agente de A não pode alcançar B.
  const tA = (await um(`insert into public.tenants (slug, nome) values ($1,$2) returning id`,
    [`z-fn-a-${Date.now()}`, 'Func A'])).id;
  const tB = (await um(`insert into public.tenants (slug, nome) values ($1,$2) returning id`,
    [`z-fn-b-${Date.now()}`, 'Func B'])).id;

  const fVendedor = (await um(
    `insert into public.tenant_funcoes (tenant_id, nome, capacidades) values ($1,'Vendedor',$2) returning id`,
    [tA, ['ver_conversas', 'marcar_pedido', 'editar_catalogo']])).id;
  const fB = (await um(
    `insert into public.tenant_funcoes (tenant_id, nome, capacidades) values ($1,'Vendedor B','{}') returning id`, [tB])).id;

  // `usuarios_painel.id` referencia `auth.users`: a pessoa entra por lá, e o
  // trigger `handle_novo_usuario` faz a projeção. Criar direto na projeção
  // violaria a FK — e, mais do que isso, não exercitaria o trigger, que esta
  // migração também mexe (ele tinha de aprender o papel `tenant_agente`).
  const novoUsuario = async (id, papel, tenant) => {
    await c.query(`insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                     raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
                   values ($1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',$2,'',$3,'{}',now(),now())`,
      [id, `z-80-${id}@teste.local`, JSON.stringify({ provider: 'email', providers: ['email'], papel, tenant_id: tenant })]);
  };
  const idAdmin = crypto.randomUUID();
  const idAgente = crypto.randomUUID();
  await novoUsuario(idAdmin, 'tenant_admin', tA);
  await novoUsuario(idAgente, 'tenant_agente', tA);
  const projAgente = await um(`select papel, tenant_id from public.usuarios_painel where id=$1`, [idAgente]);
  chk('o trigger do auth aceita o papel NOVO e projeta o agente',
    projAgente?.papel === 'tenant_agente' && projAgente.tenant_id === tA, JSON.stringify(projAgente));
  // O guard da 73/80 barra ATÉ a conexão de migração sem claim de super_admin
  // (é a mesma armadilha medida na 75, com `tenants`). O arranjo diz quem é.
  const comoSuper = async (sql, p2 = []) => {
    await c.query(`select set_config('request.jwt.claims', '{"app_metadata":{"papel":"super_admin"}}', true)`);
    try { return await c.query(sql, p2); }
    finally { await c.query(`select set_config('request.jwt.claims', '', true)`); }
  };
  await comoSuper(`update public.usuarios_painel set funcao_id=$2 where id=$1`, [idAgente, fVendedor]);

  const claims = (id, papel, tenant) => ({ sub: id, role: 'authenticated', app_metadata: { papel, tenant_id: tenant } });
  const cAdmin = claims(idAdmin, 'tenant_admin', tA);
  const cAgente = claims(idAgente, 'tenant_agente', tA);

  // 3a. capacidade inventada não entra na função
  const inventada = await como(cAdmin,
    `insert into public.tenant_funcoes (tenant_id, nome, capacidades) values ($1,'X',$2)`, [tA, ['virar_super_admin']]);
  chk('capacidade que não existe é recusada pelo CHECK', !inventada.ok && inventada.code === '23514',
    JSON.stringify(inventada));

  // 3b. admin pode tudo
  const admProd = await como(cAdmin,
    `insert into public.produtos (tenant_id, nome, preco_centavos) values ($1,'P',100)`, [tA]);
  chk('admin do tenant insere produto', admProd.ok, JSON.stringify(admProd));
  const admPrompt = await como(cAdmin,
    `insert into public.prompt_versoes (tenant_id, conteudo) values ($1,'x')`, [tA]);
  chk('admin do tenant escreve prompt', admPrompt.ok, JSON.stringify(admPrompt));

  // 3c. o agente tem editar_catalogo
  const agProd = await como(cAgente,
    `insert into public.produtos (tenant_id, nome, preco_centavos) values ($1,'P',100)`, [tA]);
  chk('agente COM editar_catalogo insere produto', agProd.ok, JSON.stringify(agProd));

  // 3d. ...e NÃO tem editar_prompt
  const agPrompt = await como(cAgente,
    `insert into public.prompt_versoes (tenant_id, conteudo) values ($1,'x')`, [tA]);
  chk('agente SEM editar_prompt não escreve prompt (porta 1: a policy)',
    !agPrompt.ok && agPrompt.code === '42501', JSON.stringify(agPrompt));

  // 3e. CONTRAPROVA: sem capacidade ele ainda LÊ. É o que a divisão
  //     select/escrita existe para garantir — pôr a capacidade na `for all`
  //     teria tirado o SELECT junto e quebrado a tela.
  await c.query(`insert into public.prompt_versoes (tenant_id, conteudo) values ($1,'historico')`, [tA]);
  const agLeituraPrompt = await como(cAgente, `select id from public.prompt_versoes where tenant_id=$1`, [tA]);
  chk('agente SEM editar_prompt AINDA LÊ o histórico (a tela não quebra)',
    agLeituraPrompt.ok && agLeituraPrompt.linhas > 0, JSON.stringify(agLeituraPrompt));

  // 3f. isolamento: nada de tenant B
  const agB = await como(cAgente, `select id from public.tenant_funcoes where tenant_id=$1`, [tB]);
  chk('agente de A não enxerga função de B', agB.ok && agB.linhas === 0, JSON.stringify(agB));
  const agProdB = await como(cAgente,
    `insert into public.produtos (tenant_id, nome, preco_centavos) values ($1,'P',100)`, [tB]);
  chk('agente de A não escreve no catálogo de B', !agProdB.ok, JSON.stringify(agProdB));

  // 3g. o agente não se autopromove
  const autoPromo = await como(cAgente,
    `update public.tenant_funcoes set capacidades = $2 where id = $1`, [fVendedor, ['editar_prompt']]);
  chk('agente não edita a própria função (senão se autopromove)',
    !autoPromo.ok || autoPromo.linhas === 0, JSON.stringify(autoPromo));
  const autoPapel = await como(cAgente,
    `update public.usuarios_painel set papel='tenant_admin' where id=$1`, [idAgente]);
  chk('agente não muda o próprio papel', !autoPapel.ok, JSON.stringify(autoPapel));

  // 3h. função de OUTRO tenant não cola
  const funcaoDeB = await como(cAdmin,
    `update public.usuarios_painel set funcao_id=$2 where id=$1`, [idAgente, fB]);
  chk('não dá para apontar alguém para função de outro tenant',
    !funcaoDeB.ok && funcaoDeB.code === '42501', JSON.stringify(funcaoDeB));

  console.log('\n== 4. A porta 2: SECURITY DEFINER, que a policy não alcança ==\n');

  const conv = 990801;
  await c.query(`insert into public.mensagens_log (tenant_id, conversation_id, direcao, conteudo, execucao_id)
                 values ($1,$2,'entrada','oi',$3)`, [tA, conv, `t80-${Date.now()}`]);

  const histAgente = await como(cAgente, `select * from public.conversa_historico($1)`, [conv]);
  chk('agente COM ver_conversas lê o histórico', histAgente.ok && histAgente.linhas > 0, JSON.stringify(histAgente));

  // tira ver_conversas da FUNÇÃO — e vale na hora, mesma conexão, sem token novo
  await c.query(`update public.tenant_funcoes set capacidades = $2 where id = $1`,
    [fVendedor, ['marcar_pedido', 'editar_catalogo']]);
  const histDepois = await como(cAgente, `select * from public.conversa_historico($1)`, [conv]);
  chk('tirar a capacidade vale NA HORA — sem token novo, mesma conexão',
    histDepois.ok && histDepois.linhas === 0, JSON.stringify(histDepois));

  // marcar_pedido pela SECURITY DEFINER
  const ped = (await um(`insert into public.pedidos (tenant_id, conversation_id, status, total_centavos)
                         values ($1,$2,'aguardando_pagamento',100) returning id`, [tA, conv])).id;
  await c.query(`update public.tenant_funcoes set capacidades = $2 where id = $1`, [fVendedor, ['editar_catalogo']]);
  const marcarSem = await como(cAgente, `select * from public.painel_marcar_pedido($1,'pago')`, [ped]);
  chk('agente SEM marcar_pedido é negado DENTRO da SECURITY DEFINER',
    marcarSem.ok && marcarSem.rows[0]?.ok === false && marcarSem.rows[0]?.motivo === 'sem_permissao',
    JSON.stringify(marcarSem.rows?.[0]));

  await c.query(`update public.tenant_funcoes set capacidades = $2 where id = $1`, [fVendedor, ['marcar_pedido']]);
  const marcarCom = await comoFirme(cAgente, `select * from public.painel_marcar_pedido($1,'pago')`, [ped]);
  chk('agente COM marcar_pedido marca o pedido',
    marcarCom.ok && marcarCom.rows[0]?.ok === true, JSON.stringify(marcarCom.rows?.[0]));
  const dep = await um(`select status from public.pedidos where id=$1`, [ped]);
  chk('...e o efeito ENTROU no banco (não basta a função dizer que sim)', dep.status === 'pago', dep.status);

  console.log('\n== 5. Sabotagem ==\n');

  // S1: a capacidade sai da policy de produtos -> o agente sem ela passaria
  await c.query('savepoint sab');
  await c.query(`drop policy p_produtos_ins on public.produtos`);
  await c.query(`create policy p_produtos_ins on public.produtos for insert
                 with check (public.auth_is_super_admin() or tenant_id = public.auth_tenant_id())`);
  await c.query(`update public.tenant_funcoes set capacidades = '{}'::text[] where id = $1`, [fVendedor]);
  const sabotado = await como(cAgente,
    `insert into public.produtos (tenant_id, nome, preco_centavos) values ($1,'P',100)`, [tA]);
  chk('S1: sem a capacidade na policy, o agente SEM permissão escreveria — a guarda do bloco 2a pega isso',
    sabotado.ok, JSON.stringify(sabotado));
  const frouxaAgora = (await c.query(`select coalesce(pg_get_expr(polwithcheck, polrelid),'') e
    from pg_policy where polname='p_produtos_ins'`)).rows[0].e;
  chk('S1: e a varredura de catálogo a classifica como frouxa', !/auth_pode\(/.test(frouxaAgora), frouxaAgora);
  await c.query('rollback to savepoint sab');

  // S2: a checagem sai da SECURITY DEFINER -> a porta 2 reabre
  await c.query('savepoint sab2');
  await c.query(`update public.tenant_funcoes set capacidades = '{}'::text[] where id = $1`, [fVendedor]);
  const ped2 = (await um(`insert into public.pedidos (tenant_id, conversation_id, status, total_centavos)
                          values ($1,$2,'aguardando_pagamento',100) returning id`, [tA, conv + 1])).id;
  const negadoAntes = await como(cAgente, `select * from public.painel_marcar_pedido($1,'pago')`, [ped2]);
  chk('S2: com a checagem, o agente sem permissão é negado',
    negadoAntes.rows?.[0]?.motivo === 'sem_permissao', JSON.stringify(negadoAntes.rows?.[0]));
  await c.query(`create or replace function public.painel_marcar_pedido(p_pedido_id uuid, p_acao text)
    returns table(ok boolean, motivo text, status text, pago_em timestamptz, retirado_em timestamptz)
    language plpgsql security definer set search_path = public as $sab$
    begin return query select true, 'sabotado'::text, 'pago'::text, now(), null::timestamptz; end; $sab$`);
  const passouSabotado = await como(cAgente, `select * from public.painel_marcar_pedido($1,'pago')`, [ped2]);
  chk('S2: SEM a checagem a mesma chamada passa — é o buraco que a porta 2 fecha',
    passouSabotado.rows?.[0]?.motivo === 'sabotado', JSON.stringify(passouSabotado.rows?.[0]));
  await c.query('rollback to savepoint sab2');

  console.log('\n== 6. O rollback aborta com gente dentro (migração que AMPLIA) ==\n');

  let abortou = null;
  await c.query('savepoint rb');
  try { await c.query(semTx(R80)); abortou = false; }
  catch (e) { abortou = /tenant_agente/.test(e.message); }
  await c.query('rollback to savepoint rb');
  chk('o rollback recusa rodar enquanto houver tenant_agente, com mensagem própria', abortou === true);
} finally {
  await c.query('rollback');
  await c.end();
}

console.log(`\n${falhas.length ? 'FALHOU' : 'passaram'}: ${ok} ok, ${falhas.length} falhas`);
if (falhas.length) { for (const f of falhas) console.log('  - ' + f); process.exit(1); }
