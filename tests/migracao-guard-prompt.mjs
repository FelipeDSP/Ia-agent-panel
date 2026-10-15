#!/usr/bin/env node
/**
 * Migração 89 — o prompt e a configuração da conta passam a pedir permissão.
 *
 * TRANSAÇÃO ABORTADA contra produção: o rollback no fim é incondicional.
 *
 * COMEÇA PELO ROLLBACK DA PRÓPRIA MIGRAÇÃO. É idempotente e põe a função no
 * estado pré-89 tendo ela sido aplicada ou não — sem isso o teste estaria
 * afirmando o calendário, que é o defeito que este repositório já pegou nove
 * vezes.
 *
 * O QUE ELE MEDE, e por que isso não dava para medir lendo código: a pergunta
 * "um atendente consegue trocar o prompt?" tem três camadas de resposta (a
 * tela esconde, a Server Action recusa, o banco barra) e só a terceira vale
 * contra quem chama a API direto com o próprio login. Foi assim que o buraco
 * apareceu em 15/10 — não por revisão, por entrar como `tenant_agente` na API
 * pública e trocar o `system_prompt` de uma conta.
 *
 *   npm run teste:guard-prompt
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let ok = 0;
const falhas = [];
const chk = (nome, cond, det = '') => {
  if (cond) { ok++; console.log(`  ok    ${nome}`); }
  else { falhas.push(nome); console.log(`  FALHA ${nome}${det ? ' - ' + det : ''}`); }
};

const ARQ = path.join(RAIZ, 'supabase/migrations/20261015160000_89_guard_prompt_por_capacidade.sql');
const BRUTO = fs.readFileSync(ARQ, 'utf8').replace(/\r\n/g, '\n');
// `lastIndexOf` e não `split`: o cabeçalho também diz "ROLLBACK: ao final do
// arquivo", e dividir pela primeira ocorrência entregava o cabeçalho como
// "migração" e o corpo como "rollback" — com o rollback saindo VAZIO e a
// migração não sendo aplicada. A guarda de tamanho abaixo foi quem denunciou.
const CORTE = BRUTO.lastIndexOf('-- ROLLBACK');
const CORPO = BRUTO.slice(0, CORTE);
const DEPOIS = BRUTO.slice(CORTE);
// O rollback mora comentado no fim do arquivo: tira o `-- ` de cada linha.
const ROLLBACK = DEPOIS.split('\n')
  .filter((l) => l.startsWith('-- ') && !/^-- =+$/.test(l.trim()))
  .map((l) => l.slice(3))
  // A linha do próprio marcador vira um `ROLLBACK` solto no início do SQL, e o
  // Postgres recusa com "syntax error at or near create" — erro que parece ser
  // do rollback e é do extrator.
  .filter((l) => l.trim() !== 'ROLLBACK')
  .join('\n');

const url = process.env.SUPABASE_DB_URL ?? fs.readFileSync(path.join(RAIZ, '.env.local'), 'utf8')
  .split(/\r?\n/).find((l) => l.startsWith('SUPABASE_DB_URL='))?.slice(16).trim().replace(/^["']|["']$/g, '');
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await c.connect();
await c.query('begin');

const claims = (o) => `set local request.jwt.claims = '${JSON.stringify(o).replace(/'/g, "''")}'`;
const comoUsuario = async (sub, papel, tenantId) =>
  c.query(claims({ sub, role: 'authenticated', app_metadata: { papel, tenant_id: tenantId } }));

/** Roda e devolve o erro em vez de derrubar o teste (savepoint para a transação sobreviver). */
const tentar = async (sql, params = []) => {
  await c.query('savepoint s');
  try {
    const r = await c.query(sql, params);
    await c.query('release savepoint s');
    return { ok: true, linhas: r.rowCount };
  } catch (e) {
    await c.query('rollback to savepoint s');
    return { ok: false, codigo: e.code, msg: String(e.message) };
  }
};

try {
  console.log('\n=== 0. O arquivo e o rollback ===\n');
  chk('o CORPO da migração foi extraído', CORPO.includes('editar_prompt') && CORPO.includes('c_admin'), `${CORPO.length} chars`);
  chk('o rollback foi extraído do arquivo', ROLLBACK.includes('create or replace function') && ROLLBACK.length > 400,
    `${ROLLBACK.length} chars`);
  chk('...e ele NÃO contém as regras novas (é mesmo o estado anterior)',
    !/editar_prompt|c_admin/.test(ROLLBACK));

  // Estado pré-89, aplicado ou não.
  await c.query(ROLLBACK);
  console.log('  (função no estado pré-89)');

  // ---- arranjo: um tenant e três identidades ------------------------------
  const slug = 'zz-guard89-' + crypto.randomUUID().slice(0, 8);
  // `max_agentes` no INSERT: o teto da migração 81 recusa a linha de atendente
  // em `usuarios_painel` quando ele é 0 (o padrão), e o teste precisa de dois.
  const [t] = (await c.query(
    `insert into public.tenants (slug, nome, system_prompt, modelo, max_agentes)
     values ($1, 'Guard 89', 'prompt original', 'gpt-4.1-mini', 5) returning id`, [slug])).rows;

  const idAdmin = crypto.randomUUID();
  const idAgente = crypto.randomUUID();
  const idAgenteComCap = crypto.randomUUID();
  // `usuarios_painel` referencia `auth.users`; na transação abortada dá para
  // criar as duas pontas, que é o que permite a LINHA decidir (e não só o claim).
  for (const [id, email] of [[idAdmin, 'a'], [idAgente, 'b'], [idAgenteComCap, 'c']]) {
    await c.query(
      `insert into auth.users (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at)
       values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, '', now(), now())
       on conflict (id) do nothing`, [id, `${email}-${slug}@exemplo.invalido`]);
  }
  const [funcao] = (await c.query(
    `insert into public.tenant_funcoes (tenant_id, nome, capacidades)
     values ($1, 'Atendente que edita prompt', array['editar_prompt']) returning id`, [t.id])).rows;
  await c.query(
    `insert into public.usuarios_painel (id, tenant_id, email, nome, papel, ativo)
     values ($1,$2,$3,'Admin','tenant_admin',true)`, [idAdmin, t.id, `a-${slug}@exemplo.invalido`]);
  await c.query(
    `insert into public.usuarios_painel (id, tenant_id, email, nome, papel, ativo)
     values ($1,$2,$3,'Atendente','tenant_agente',true)`, [idAgente, t.id, `b-${slug}@exemplo.invalido`]);
  await c.query(
    `insert into public.usuarios_painel (id, tenant_id, email, nome, papel, ativo, funcao_id)
     values ($1,$2,$3,'Atendente+','tenant_agente',true,$4)`,
    [idAgenteComCap, t.id, `c-${slug}@exemplo.invalido`, funcao.id]);

  const mudarPrompt = (texto) => tentar('update public.tenants set system_prompt=$2 where id=$1', [t.id, texto]);
  const desligarAgente = () => tentar('update public.tenants set agente_ativo = not agente_ativo where id=$1', [t.id]);
  const mudarModelo = () => tentar(`update public.tenants set modelo='gpt-5' where id=$1`, [t.id]);

  // =========================================================================
  console.log('\n=== 1. ANTES da 89: o atendente troca o prompt ===\n');

  // É a contraprova da migração inteira. Sem ela, as recusas do item 2
  // poderiam vir de qualquer outra coisa — e não haveria defeito consertado.
  await c.query('set local role authenticated');
  await comoUsuario(idAgente, 'tenant_agente', t.id);
  const antes = await mudarPrompt('invadido antes da 89');
  chk('o atendente MUDAVA o prompt (o defeito que a 89 fecha)', antes.ok === true,
    `${antes.codigo}: ${antes.msg}`);
  await c.query('reset role');
  await c.query('reset request.jwt.claims');
  await c.query('update public.tenants set system_prompt=$2 where id=$1', [t.id, 'prompt original']);

  // =========================================================================
  console.log('\n=== 2. DEPOIS da 89 ===\n');

  await c.query(CORPO);
  console.log('  (migração aplicada na transação)\n');

  await c.query('set local role authenticated');

  await comoUsuario(idAgente, 'tenant_agente', t.id);
  const r1 = await mudarPrompt('invadido');
  chk('atendente SEM capacidade é recusado ao mudar o prompt', r1.ok === false && r1.codigo === '42501',
    JSON.stringify(r1));
  chk('...com mensagem que nomeia a capacidade', /editar_prompt/.test(r1.msg ?? ''), r1.msg);
  const r2 = await desligarAgente();
  chk('atendente é recusado ao LIGAR/DESLIGAR o agente', r2.ok === false && r2.codigo === '42501', JSON.stringify(r2));
  chk('...com mensagem que fala em administrador', /administrador/i.test(r2.msg ?? ''), r2.msg);

  await comoUsuario(idAgenteComCap, 'tenant_agente', t.id);
  const r3 = await mudarPrompt('mudado por quem pode');
  chk('atendente COM `editar_prompt` muda o prompt', r3.ok === true, JSON.stringify(r3));
  const r4 = await desligarAgente();
  chk('...mas continua sem desligar o agente (isso é do admin)', r4.ok === false && r4.codigo === '42501', JSON.stringify(r4));

  await comoUsuario(idAdmin, 'tenant_admin', t.id);
  const r5 = await mudarPrompt('mudado pelo admin');
  chk('ADMIN da conta muda o prompt', r5.ok === true, JSON.stringify(r5));
  const r6 = await desligarAgente();
  chk('ADMIN liga/desliga o agente', r6.ok === true, JSON.stringify(r6));
  const r7 = await mudarModelo();
  chk('ADMIN continua sem tocar em coluna da AGÊNCIA (a regra antiga vale)',
    r7.ok === false && r7.codigo === '42501', JSON.stringify(r7));

  await c.query('reset role');
  await c.query('reset request.jwt.claims');

  console.log('\n--- o super_admin da agência não é afetado ---\n');
  await c.query('set local role authenticated');
  await comoUsuario(idAdmin, 'super_admin', null);
  const r8 = await mudarModelo();
  chk('super_admin muda coluna da agência', r8.ok === true, JSON.stringify(r8));
  const r9 = await mudarPrompt('mudado pela agência');
  chk('super_admin muda o prompt de qualquer conta', r9.ok === true, JSON.stringify(r9));
  await c.query('reset role');
  await c.query('reset request.jwt.claims');

  // =========================================================================
  console.log('\n=== 3. A LINHA decide, não só o claim ===\n');

  /*
   * `auth_capacidades` olha a linha de `usuarios_painel` quando ela existe, e o
   * claim só quando não existe — é o que faz revogar uma função valer na hora,
   * sem esperar o JWT expirar. A 89 segue a mesma ordem, e isto mede: um claim
   * dizendo `tenant_admin` para um usuário cuja LINHA diz `tenant_agente` não
   * compra permissão.
   */
  await c.query('set local role authenticated');
  await comoUsuario(idAgente, 'tenant_admin', t.id);
  const r10 = await desligarAgente();
  chk('claim mentindo "tenant_admin" não vence a linha que diz atendente',
    r10.ok === false && r10.codigo === '42501', JSON.stringify(r10));
  // CONTRAPROVA: o mesmo claim, para quem a linha diz admin, passa.
  await comoUsuario(idAdmin, 'tenant_admin', t.id);
  const r11 = await desligarAgente();
  chk('CONTRAPROVA: o admin de verdade passa com o mesmo claim', r11.ok === true, JSON.stringify(r11));
  await c.query('reset role');
  await c.query('reset request.jwt.claims');

  // =========================================================================
  console.log('\n=== 4. A migração é reexecutável e o rollback volta ===\n');

  const r12 = await tentar(CORPO);
  chk('aplicar a 89 duas vezes não quebra', r12.ok === true, JSON.stringify(r12));
  await c.query(ROLLBACK);
  await c.query('set local role authenticated');
  await comoUsuario(idAgente, 'tenant_agente', t.id);
  const r13 = await mudarPrompt('depois do rollback');
  chk('o rollback devolve o comportamento antigo (atendente volta a mudar)', r13.ok === true, JSON.stringify(r13));
  await c.query('reset role');
  await c.query('reset request.jwt.claims');
} finally {
  await c.query('rollback');
  console.log('\n(transação abortada — nada ficou no banco)');
  await c.end();
}

console.log(`\n${falhas.length ? 'FALHOU' : 'passaram'}: ${ok} ok, ${falhas.length} falhas`);
if (falhas.length) { for (const f of falhas) console.log('  - ' + f); process.exit(1); }
