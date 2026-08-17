/**
 * Guarda de dado alheio: tira um retrato de cada tenant antes e depois de um
 * comando e reprova se ele mexeu em tenant que não criou.
 *
 * POR QUE EXISTE. Vários testes apagam por padrão de nome ou por id de conversa,
 * sem filtro de tenant, rodando como service_role — que ignora RLS. Hoje nada
 * some porque `__teste_iso_prod__` é um nome improvável e 990001 é um
 * conversation_id improvável. A garantia é estatística: no dia em que um cliente
 * cadastrar o nome errado ou o Chatwoot emitir o id errado, o catálogo dele vai
 * embora sem que teste nenhum reclame.
 *
 * CHECKSUM, NÃO CONTAGEM. Contagem não vê UPDATE (um preço alterado) nem
 * apaga-um-cria-um. O retrato é o md5 de cada linha, então mudança de conteúdo
 * aparece mesmo com o total intacto.
 *
 * O QUE ELA NÃO FAZ. Detecta, não previne: quando o alarme toca, a linha já
 * sumiu. Quem previne é rodar em branch. As duas juntas é que fecham.
 *
 * `embedding` fica fora do md5 — é vetor, pesa, e não muda sem `text` mudar.
 */

/**
 * ESTRUTURAL: só muda por ação humana ou por teste. Sempre vigiado.
 * OPERACIONAL: o agente escreve sozinho durante uma conversa. Vigiado por
 * padrão porque hoje não há tráfego; quando houver, uma mensagem chegando no
 * meio da suíte vira falso positivo e aí se roda com `--estrutural`.
 *
 * `chave` é a identidade da linha — é o que permite dizer "mudou" em vez de
 * "sumiu uma e apareceu outra". Pode ser expressão SQL para chave composta.
 */
export const TABELAS = [
  { tabela: 'tenants', tenant: 'id', chave: 'id::text', grupo: 'estrutural' },
  { tabela: 'produtos', tenant: 'tenant_id', chave: 'id::text', grupo: 'estrutural' },
  { tabela: 'tenant_tools', tenant: 'tenant_id', chave: 'id::text', grupo: 'estrutural' },
  { tabela: 'kb_documentos', tenant: 'tenant_id', chave: 'id::text', grupo: 'estrutural' },
  { tabela: 'prompt_versoes', tenant: 'tenant_id', chave: 'id::text', grupo: 'estrutural' },
  { tabela: 'usuarios_painel', tenant: 'tenant_id', chave: 'id::text', grupo: 'estrutural' },
  { tabela: 'tenant_credenciais', tenant: 'tenant_id', chave: 'tenant_id::text', grupo: 'estrutural' },
  { tabela: 'pedidos', tenant: 'tenant_id', chave: 'id::text', grupo: 'operacional' },
  { tabela: 'pedido_itens', tenant: 'tenant_id', chave: 'id::text', grupo: 'operacional' },
  { tabela: 'conversas', tenant: 'tenant_id', chave: 'id::text', grupo: 'operacional' },
  { tabela: 'mensagens_log', tenant: 'tenant_id', chave: 'id::text', grupo: 'operacional' },
  { tabela: 'fotos_enviadas', tenant: 'tenant_id', chave: 'id::text', grupo: 'operacional' },
  { tabela: 'jobs_ingestao', tenant: 'tenant_id', chave: 'id::text', grupo: 'operacional' },
  { tabela: 'uso_ingestao', tenant: 'tenant_id', chave: 'id::text', grupo: 'operacional' },
];

/**
 * `pg` entra por import dinâmico de propósito: `comparar` e `formatarRelatorio`
 * são funções puras, e exigir driver de banco para exercitá-las tornaria a
 * lógica da guarda testável só com banco na mão — que é o oposto do ponto.
 */
export async function abrirConexao(url) {
  const { Client } = await import('pg');
  const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();
  return c;
}

/**
 * Descobre as colunas de cada tabela no banco em vez de listá-las aqui.
 *
 * Duas razões. Primeira: coluna nova entra na vigilância sozinha — uma lista
 * fixa aqui envelheceria calada, e guarda que envelhece calada é a própria
 * classe de bug que ela deveria pegar. Segunda: `to_jsonb(linha)` seria mais
 * curto, mas serializaria o `embedding` (1536 floats × centenas de chunks) só
 * para descartá-lo em seguida. Colunas de tipo vetor e binário ficam de fora do
 * hash: não mudam sem que o texto de origem mude.
 */
async function descobrirColunas(c, tabelas) {
  const { rows } = await c.query(
    `select table_name, column_name, udt_name
       from information_schema.columns
      where table_schema = 'public' and table_name = any($1)
      order by table_name, ordinal_position`,
    [tabelas.map((t) => t.tabela)],
  );

  const IGNORADAS = new Set(['vector', 'bytea']);
  const porTabela = new Map();

  for (const r of rows) {
    if (IGNORADAS.has(r.udt_name)) continue;
    if (!porTabela.has(r.table_name)) porTabela.set(r.table_name, []);
    porTabela.get(r.table_name).push(`"${r.column_name}"`);
  }

  for (const t of tabelas) {
    if (!porTabela.get(t.tabela)?.length) {
      throw new Error(`tabela vigiada "${t.tabela}" não existe no banco — atualize TABELAS`);
    }
  }

  return porTabela;
}

function montarSql(tabelas, colunas) {
  return tabelas
    .map(
      (t) =>
        `select '${t.tabela}' as tabela, x.${t.tenant}::text as tenant_id, ` +
        `(x.${t.chave}) as chave, md5(row(${colunas.get(t.tabela).map((col) => `x.${col}`).join(', ')})::text) as hash ` +
        `from public.${t.tabela} x`,
    )
    .join('\n union all \n');
}

/**
 * Retrato do banco inteiro, agrupado por tenant.
 * Devolve { slugs: Map<id,slug>, linhas: Map<tabela, Map<tenantId, Map<chave,hash>>> }
 *
 * Roda em REPEATABLE READ: as linhas e a lista de tenants precisam vir do mesmo
 * instante, senão um tenant criado entre as duas consultas apareceria com dado
 * e sem slug — e seria acusado de ser alheio.
 */
export async function tirarSnapshot(c, { apenasEstrutural = false } = {}) {
  const tabelas = apenasEstrutural ? TABELAS.filter((t) => t.grupo === 'estrutural') : TABELAS;

  const linhas = new Map();
  for (const t of tabelas) linhas.set(t.tabela, new Map());

  await c.query('begin transaction isolation level repeatable read read only');
  let rows;
  let ts;
  try {
    const colunas = await descobrirColunas(c, tabelas);
    ({ rows } = await c.query(montarSql(tabelas, colunas)));
    ({ rows: ts } = await c.query('select id::text as id, slug from public.tenants'));
    await c.query('commit');
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  }

  for (const r of rows) {
    const porTenant = linhas.get(r.tabela);
    const id = r.tenant_id ?? '(sem tenant)';
    if (!porTenant.has(id)) porTenant.set(id, new Map());
    porTenant.get(id).set(r.chave, r.hash);
  }

  const slugs = new Map(ts.map((t) => [t.id, t.slug]));

  return { slugs, linhas };
}

/**
 * Compara dois retratos. Tenant que nasceu durante o comando é ignorado — é
 * exatamente o que um teste com tenant efêmero deve fazer. Tenant que existia e
 * sumiu é o alarme mais alto que esta ferramenta sabe dar.
 */
export function comparar(antes, depois) {
  const divergencias = [];
  const criados = [];

  for (const [id, slug] of depois.slugs) if (!antes.slugs.has(id)) criados.push(slug);

  for (const [id, slug] of antes.slugs) {
    if (!depois.slugs.has(id)) {
      divergencias.push({ slug, tabela: 'tenants', tipo: 'TENANT APAGADO', sumiram: ['—'], surgiram: [], mudaram: [] });
    }
  }

  for (const [tabela, porTenantAntes] of antes.linhas) {
    const porTenantDepois = depois.linhas.get(tabela) ?? new Map();
    const ids = new Set([...porTenantAntes.keys(), ...porTenantDepois.keys()]);

    for (const id of ids) {
      // Nasceu durante o comando: fora da vigilância.
      if (!antes.slugs.has(id) && id !== '(sem tenant)') continue;

      const a = porTenantAntes.get(id) ?? new Map();
      const d = porTenantDepois.get(id) ?? new Map();

      const sumiram = [];
      const surgiram = [];
      const mudaram = [];

      for (const [chave, hash] of a) {
        if (!d.has(chave)) sumiram.push(chave);
        else if (d.get(chave) !== hash) mudaram.push(chave);
      }
      for (const chave of d.keys()) if (!a.has(chave)) surgiram.push(chave);

      if (sumiram.length || surgiram.length || mudaram.length) {
        divergencias.push({
          slug: antes.slugs.get(id) ?? id,
          tabela,
          tipo: 'ALTERADO',
          sumiram,
          surgiram,
          mudaram,
        });
      }
    }
  }

  return { divergencias, criados };
}

export function formatarRelatorio({ divergencias, criados }) {
  const linhas = [];

  if (criados.length) {
    linhas.push(`  (tenants criados durante o comando, fora da vigilância: ${criados.join(', ')})`);
  }

  if (!divergencias.length) {
    linhas.push('  OK    nenhum tenant preexistente foi tocado');
    return linhas.join('\n');
  }

  linhas.push(`  FALHA ${divergencias.length} divergência(s) em tenant que o comando não criou:\n`);

  for (const d of divergencias) {
    const partes = [];
    if (d.sumiram.length) partes.push(`-${d.sumiram.length}`);
    if (d.surgiram.length) partes.push(`+${d.surgiram.length}`);
    if (d.mudaram.length) partes.push(`~${d.mudaram.length}`);

    linhas.push(`    ${d.tipo}  ${d.slug} / ${d.tabela}  [${partes.join(' ')}]`);

    const exemplo = (rotulo, lista) => {
      if (!lista.length) return;
      const mostra = lista.slice(0, 5).join(', ');
      const resto = lista.length > 5 ? ` … +${lista.length - 5}` : '';
      linhas.push(`        ${rotulo}: ${mostra}${resto}`);
    };
    exemplo('sumiu', d.sumiram);
    exemplo('surgiu', d.surgiram);
    exemplo('mudou', d.mudaram);
  }

  return linhas.join('\n');
}
