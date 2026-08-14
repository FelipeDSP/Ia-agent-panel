#!/usr/bin/env node
/**
 * Nenhuma função de `public` tem duas assinaturas vivas.
 *
 * POR QUE ISTO É UM TESTE E NÃO UMA LINHA DE DOC. É a terceira vez que a mesma
 * armadilha aparece: acrescentar um parâmetro COM DEFAULT e usar `create or
 * replace` não substitui nada — `or replace` só troca a função de mesma aridade.
 * As duas ficam vivas, e a chamada com a contagem ANTIGA de argumentos vira
 * AMBÍGUA. Aconteceu na migração 28 (`fechar_pedido`), foi evitada na 32 e na 37
 * porque alguém lembrou. Lembrar não escala.
 *
 * O ESTRAGO É EM RUNTIME, não na migração. O `create or replace` passa verde, o
 * `supabase db push` passa verde, e o n8n — que chama pela aridade antiga —
 * estoura `function is not unique` (42725) na primeira mensagem de um cliente
 * real. Nada no banco indica que faltou nada.
 *
 * PROPRIEDADE, NÃO ESTADO DO MUNDO: não afirma "existem N funções" nem lista
 * quais. Afirma que nenhuma tem sobrecarga. Continua verdadeiro depois de cada
 * função nova, e fica vermelho exatamente quando alguém esquece o drop.
 *
 * SE UMA SOBRECARGA FOR DELIBERADA um dia, declare em SOBRECARGAS_ACEITAS com o
 * motivo. Exceção declarada e versionada é decisão; exceção silenciosa é o bug.
 *
 * Uso: npm run teste:assinaturas
 */

import pg from 'pg';

/**
 * Funções que podem ter mais de uma assinatura, com o porquê.
 * Vazio hoje — produção não tem nenhuma sobrecarga, e é assim que se quer.
 */
const SOBRECARGAS_ACEITAS = {
  // 'nome_da_funcao': 'motivo pelo qual as duas assinaturas existem de propósito',
};

if (!process.env.SUPABASE_DB_URL) {
  console.error('SUPABASE_DB_URL ausente. Rode com --env-file=.env.local');
  process.exit(1);
}

const c = new pg.Client({
  connectionString: process.env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
});

await c.connect();

// `prokind='f'` exclui procedures e agregados. Extensões instalam funções em
// schemas próprios (`extensions`, `vault`), então `public` já as deixa de fora.
const { rows } = await c.query(`
  select p.proname,
         count(*)::int n,
         string_agg(pg_get_function_identity_arguments(p.oid), E'\\n         ' order by p.oid) args
    from pg_proc p
    join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public'
     and p.prokind = 'f'
   group by p.proname
  having count(*) > 1
   order by p.proname
`);

await c.end();

console.log('\n== Assinatura única por função em public ==\n');

const inesperadas = rows.filter((r) => !(r.proname in SOBRECARGAS_ACEITAS));
const aceitas = rows.filter((r) => r.proname in SOBRECARGAS_ACEITAS);

for (const r of aceitas) {
  console.log(`  OK    ${r.proname}: ${r.n} assinaturas, aceitas — ${SOBRECARGAS_ACEITAS[r.proname]}`);
}

for (const r of inesperadas) {
  console.log(`  FALHA ${r.proname}: ${r.n} assinaturas vivas`);
  console.log(`         ${r.args}`);
}

if (inesperadas.length === 0) {
  console.log('  OK    nenhuma função com sobrecarga não declarada');
}

console.log('\n' + '-'.repeat(60));
if (inesperadas.length > 0) {
  console.log(
    `  ${inesperadas.length} função(ões) com assinatura duplicada.\n` +
      '  A chamada com a aridade antiga vira ambígua e estoura 42725 em runtime.\n' +
      '  Conserto: drop function <nome>(<lista completa de tipos da assinatura VELHA>).\n',
  );
} else {
  console.log('  nenhuma sobrecarga acidental\n');
}

process.exitCode = inesperadas.length > 0 ? 1 : 0;
