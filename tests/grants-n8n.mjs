#!/usr/bin/env node
/**
 * Toda `api_n8n_*` é executável pelo role com que o n8n conecta.
 *
 * POR QUE EXISTE. Em 17/08/2026 a migração 41 dropou e recriou
 * `api_n8n_buscar_produtos` e restaurou o grant só para `service_role`. O
 * catálogo morreu em produção com "permission denied for function". A mesma
 * migração 40, aplicada horas antes, tinha deixado `api_n8n_ver_pedido` no mesmo
 * estado — e ninguém tinha esbarrado ainda.
 *
 * `DROP FUNCTION` APAGA O ACL INTEIRO. Recriar restaura só o que o script
 * listar, e `service_role` é o role do PostgREST/supabase-js: o n8n não passa
 * por ali, ele conecta como `n8n_agent`. Verificar a função "por fora", com uma
 * conexão de superusuário, não vê nada disso — foi exatamente o erro da
 * verificação da 41, que conferiu os grants que ESPERAVA em vez dos que existiam.
 *
 * É a quinta armadilha de assinatura do repo (28, 32, 37, 40, 41) e a primeira
 * cujo modo de falha não é ambiguidade de aridade, e sim grant perdido. As
 * quatro primeiras quebravam a chamada; esta quebra a AUTORIZAÇÃO, e o sintoma
 * chega igual: a tool para no primeiro cliente.
 *
 * O teste é de PROPRIEDADE e não de lista: varre `api_n8n_*` no banco, então
 * função nova entra na vigilância sozinha. Uma lista fixa aqui envelheceria
 * calada — e guarda que envelhece calada é a classe de bug que ela deveria pegar.
 *
 * Uso: npm run teste:grants-n8n
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

const RAIZ = fileURLToPath(new URL('../', import.meta.url));
const env = fs.readFileSync(path.join(RAIZ, '.env.local'), 'utf8');
const URL_BANCO = env
  .split(/\r?\n/)
  .find((l) => l.startsWith('SUPABASE_DB_URL='))
  ?.slice('SUPABASE_DB_URL='.length)
  .trim()
  .replace(/^["']|["']$/g, '');

if (!URL_BANCO) {
  console.error('\n  SUPABASE_DB_URL ausente no .env.local\n');
  process.exit(64);
}

/** O role com que o n8n conecta. Se mudar, muda aqui — e o teste diz por quê. */
const ROLE_N8N = 'n8n_agent';

let passou = 0;
const falhas = [];

function checar(nome, ok, detalhe = '') {
  if (ok) {
    passou++;
    console.log(`  OK    ${nome}`);
  } else {
    falhas.push(`${nome}${detalhe ? ` — ${detalhe}` : ''}`);
    console.log(`  FALHA ${nome}${detalhe ? ` — ${detalhe}` : ''}`);
  }
}

const c = new Client({ connectionString: URL_BANCO, ssl: { rejectUnauthorized: false } });
await c.connect();

try {
  console.log('\n== Grants das funções api_n8n_* ==\n');

  const { rows: roles } = await c.query('select 1 from pg_roles where rolname = $1', [ROLE_N8N]);
  checar(
    `o role "${ROLE_N8N}" existe no banco`,
    roles.length === 1,
    'sem ele o teste inteiro seria vácuo — toda checagem abaixo passaria por ausência',
  );
  if (roles.length !== 1) throw new Error(`role ${ROLE_N8N} nao existe`);

  const { rows: fns } = await c.query(
    `select p.proname,
            pg_get_function_identity_arguments(p.oid) as args,
            coalesce(has_function_privilege($1, p.oid, 'execute'), false) as pode,
            coalesce(array_to_string(p.proacl, ' '), '(sem acl)') as acl
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname like 'api\\_n8n\\_%'
      order by p.proname`,
    [ROLE_N8N],
  );

  // Sem esta asserção, um erro no LIKE deixaria a varredura vazia e o teste
  // inteiro verde. É a mesma vacuidade que o repo varreu em 17/08.
  checar(
    `a varredura achou funções api_n8n_* (${fns.length})`,
    fns.length >= 10,
    `só ${fns.length} — o filtro deve estar errado`,
  );

  const semGrant = fns.filter((f) => !f.pode);
  checar(
    `todas as ${fns.length} api_n8n_* são executáveis por ${ROLE_N8N}`,
    semGrant.length === 0,
    semGrant.map((f) => `${f.proname} [acl: ${f.acl}]`).join(' | '),
  );

  // service_role tambem, porque o painel e a Edge Function passam por ele.
  const { rows: fnsSr } = await c.query(
    `select p.proname, coalesce(has_function_privilege('service_role', p.oid, 'execute'), false) as pode
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname like 'api\\_n8n\\_%'`,
  );
  const semSr = fnsSr.filter((f) => !f.pode).map((f) => f.proname);
  checar('todas continuam executáveis por service_role', semSr.length === 0, semSr.join(', '));

  // E o outro lado: quem NAO pode continuar podendo. Um `grant to public` num
  // create descuidado abriria a API do n8n para qualquer sessao autenticada.
  for (const role of ['anon', 'authenticated']) {
    const { rows } = await c.query(
      `select p.proname
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname like 'api\\_n8n\\_%'
          and coalesce(has_function_privilege($1, p.oid, 'execute'), false)`,
      [role],
    );
    // Tres delas sao chamadas pelo painel com JWT de tenant e por isso tem
    // grant a authenticated de proposito. A assercao afirma a LISTA, para que
    // uma quarta aparecer seja falha e nao silencio.
    const esperadas = role === 'authenticated' || role === 'anon'
      ? ['api_n8n_enviar_foto', 'api_n8n_pode_transcrever', 'api_n8n_registrar_mensagem', 'api_n8n_tem_pedido_pendente']
      : [];
    const inesperadas = rows.map((r) => r.proname).filter((n) => !esperadas.includes(n));
    checar(
      `nenhuma api_n8n_* nova ficou aberta para ${role}`,
      inesperadas.length === 0,
      inesperadas.join(', '),
    );
  }

  // PROVA FUNCIONAL, e nao so leitura de catalogo: `has_function_privilege` diz
  // o que o ACL contem, e chamar diz o que acontece. As duas divergem quando o
  // problema esta em outro lugar (search_path, owner, dependencia sem grant).
  console.log('\n  -- chamando de verdade, como o n8n chama --');
  const { rows: [tenant] } = await c.query('select id from public.tenants where deletado_em is null limit 1');
  const chamadas = [
    ['api_n8n_ver_pedido', 'select public.api_n8n_ver_pedido($1,$2)', [tenant.id, 990999]],
    ['api_n8n_buscar_produtos', 'select texto from public.api_n8n_buscar_produtos($1,$2)', [tenant.id, 'x']],
    ['api_n8n_tem_pedido_pendente', 'select public.api_n8n_tem_pedido_pendente($1,$2)', [tenant.id, 990999]],
    ['api_n8n_tools_ativas', 'select * from public.api_n8n_tools_ativas($1)', [tenant.id]],
  ];
  for (const [nome, sql, args] of chamadas) {
    await c.query('begin');
    let erro = null;
    try {
      await c.query(`set local role ${ROLE_N8N}`);
      await c.query(sql, args);
    } catch (e) {
      erro = e.message;
    }
    await c.query('rollback');
    checar(`${nome} responde como ${ROLE_N8N}`, erro === null, erro ?? '');
  }
} catch (e) {
  falhas.push(`ERRO INESPERADO: ${e.message}`);
  console.log(`  FALHA ERRO INESPERADO: ${e.message}`);
} finally {
  await c.end();
}

console.log(`\n${'-'.repeat(60)}`);
console.log(`  ${passou} passaram, ${falhas.length} falharam\n`);
if (falhas.length) {
  for (const f of falhas) console.log(`   - ${f}`);
  console.log('');
  process.exitCode = 1;
}
