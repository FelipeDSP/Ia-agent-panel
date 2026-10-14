/**
 * O RETRATO DE UM TENANT — checksum de tudo que é dele, para provar que um
 * caminho de código não escreveu nada.
 *
 * Usado pelo ensaio do agente (`POST /testar`) e pelo turno do assistente do
 * painel: os dois prometem "só leitura", e promessa dessas se mede comparando
 * antes e depois.
 *
 * ================== DUAS LIÇÕES, AS DUAS PAGAS ==================
 *
 * 1. CHECKSUM, NÃO CONTAGEM. `count(*)` não vê UPDATE, nem apaga-um-cria-um.
 *    `tests/lib/guarda-tenants.mjs` já dizia isso desde agosto; os dois testes
 *    novos de 14/10 nasceram contando, e a sabotagem provou o furo: um
 *    `update` em `tenants` passou com o teste VERDE e zero falhas.
 *
 * 2. A LISTA DE TABELAS NÃO SAI DA MINHA CABEÇA, E O PREDICADO TAMBÉM NÃO.
 *    A primeira versão derivava a lista do catálogo — "toda tabela de `public`
 *    com coluna `tenant_id`" — e me pareceu à prova de esquecimento. Só que
 *    `tenants` NÃO TEM `tenant_id`: a chave dela é `id`. Então a tabela mais
 *    importante de todas ficava fora de um retrato que eu tinha certeza de ser
 *    completo. Derivar protege contra esquecer um NOME; não protege contra
 *    errar o PREDICADO.
 *
 * `vector` fica fora do hash: é o embedding, pesa quilos e não muda sem o
 * texto ao lado mudar — mesma escolha da guarda.
 */

/** As tabelas de um tenant, e por qual coluna cada uma pertence a ele. */
export async function tabelasDoTenant(q) {
  const comTenantId = (await q(`select c.relname tabela
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attname = 'tenant_id' and a.attnum > 0
     where n.nspname = 'public' and c.relkind = 'r'
     order by 1`)).map((r) => ({ tabela: r.tabela, coluna: 'tenant_id' }));

  // `tenants` entra à mão porque o predicado dela é outro — e é justamente a
  // tabela onde moram prompt, horário e módulos: o que estes testes guardam.
  return [{ tabela: 'tenants', coluna: 'id' }, ...comTenantId];
}

/**
 * O retrato: um md5 por tabela, sobre o CONTEÚDO das linhas daquele tenant.
 *
 * `'(vazio)'` para tabela sem linha, em vez de null, para a comparação ser
 * entre strings sempre — e para "sumiu tudo" não parecer igual a "nunca teve".
 */
export async function retratoDoTenant(q, tenantId, tabelas) {
  const lista = tabelas ?? await tabelasDoTenant(q);
  const o = {};
  for (const { tabela, coluna } of lista) {
    const cols = (await q(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = $1 and udt_name <> 'vector'
        order by ordinal_position`, [tabela])).map((r) => `t.${JSON.stringify(r.column_name).replace(/"/g, '"')}`);
    if (cols.length === 0) { o[tabela] = '(sem colunas)'; continue; }
    const [{ h }] = await q(
      `select coalesce(md5(string_agg(l, '|' order by l)), '(vazio)') h
         from (select row(${cols.join(', ')})::text l
                 from public.${tabela} t where t.${coluna} = $1) s`, [tenantId]);
    o[tabela] = h;
  }
  return o;
}

/** As tabelas cujo conteúdo mudou entre dois retratos. */
export function diferencas(antes, depois) {
  return Object.keys(antes).filter((t) => antes[t] !== depois[t]);
}
