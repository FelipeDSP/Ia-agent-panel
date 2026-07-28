#!/usr/bin/env node
/**
 * Carga unica do banco de producao (Coolify) para o Supabase.
 *
 * Nao e uma migracao in-place. O banco de origem nunca e alterado: e lido e
 * so. O rollback do cutover e reapontar o n8n de volta, nao desfazer DDL.
 *
 * Idempotente: rodar duas vezes produz o mesmo resultado. Os ids das linhas
 * filhas sao UUID v5 derivados de (tenant, tabela de origem, pk de origem),
 * entao a segunda execucao faz UPDATE das mesmas linhas em vez de duplicar.
 * Isso e o que torna o ensaio, a re-execucao e a carga de delta seguros.
 *
 * Uso:
 *   node scripts/import-producao.mjs --dry-run      # le, valida, nao escreve
 *   node scripts/import-producao.mjs                # importa
 *   node scripts/import-producao.mjs --purge-seed   # remove o seed do tenant antes
 *
 * Credenciais em .env.local na raiz do projeto (fora do git):
 *   PROD_DB_URL      postgres://user:senha@SEU_HOST_POSTGRES:5432/postgres
 *   SUPABASE_DB_URL  postgres://postgres:senha@...   (role que bypassa RLS)
 *
 * Dependencia: npm i pg
 */

import crypto from 'node:crypto';
import pg from 'pg';

import { carregarEnv } from './lib/env.mjs';

// Credenciais do .env.local, que esta no .gitignore.
carregarEnv();

// ---------------------------------------------------------------------------
// Configuracao
// ---------------------------------------------------------------------------

/**
 * Namespace fixo do projeto para o UUID v5. Nao mude depois da primeira carga:
 * mudar aqui gera ids diferentes e a proxima execucao duplica tudo em vez de
 * atualizar.
 */
const NAMESPACE = 'a3f1c9e2-7b04-4d18-9c6e-1f2a5b8d3e07';

/** O tenant desta carga. A origem e single-tenant: o banco inteiro e a Acqua. */
const CHATWOOT_ACCOUNT_ID = 56;

/** Mapeamento contatos_chatwoot -> conversas. Colunas confirmadas na origem. */
const MAPA_CONVERSAS = {
  conversation_id: 'conversation_id',
  contact_name:    'contact_name',
  phone:           'phone',
  status:          'status',
  pausado_em:      'pausado_em',
  criado_em:       'criado_em',
};

/**
 * Fuso do banco de origem.
 *
 * As colunas de data da origem sao TIMESTAMP WITHOUT TIME ZONE; o destino usa
 * TIMESTAMPTZ. Um timestamp sem fuso inserido em TIMESTAMPTZ e interpretado no
 * fuso da sessao — se a origem gravou horario de Sao Paulo e a sessao do
 * Supabase esta em UTC, toda conversa desloca 3 horas. Nao da erro: so fica
 * errado, e so aparece quando alguem estranha a "ultima atividade".
 *
 * Postgres em Docker normalmente roda em UTC, que e o padrao aqui. O preflight
 * imprime o fuso da origem e a data mais recente ao lado de now() — se houver
 * deslocamento, aparece ali.
 */
const TZ_ORIGEM = 'UTC';

/**
 * status da origem -> CHECK de conversas.status ('ativo','pausado','resolvido').
 *
 * NAO CONFIRMADO: nao sei quais valores existem em producao. Se a origem usa os
 * status do proprio Chatwoot ('open', 'resolved', 'pending'), preencha aqui.
 *
 * O preflight ABORTA diante de valor nao mapeado, em vez de assumir um padrao.
 * A versao anterior deste script normalizava desconhecido para 'ativo' — se a
 * origem usasse 'resolved', toda conversa encerrada voltaria como ativa e o
 * agente comecaria a responder em conversa fechada. Silencioso e em producao.
 */
const MAPA_STATUS = {
  ativo:     'ativo',
  pausado:   'pausado',
  resolvido: 'resolvido',
  // open:    'ativo',
  // pending: 'ativo',
  // resolved:'resolvido',
};

/** Colunas que documentos precisa ter. */
const COLUNAS_DOCUMENTOS = ['id', 'text', 'embedding', 'metadata', 'criado_em'];

const DIMENSAO_ESPERADA = 1536;

// ---------------------------------------------------------------------------
// UUID v5 (RFC 4122) — sem dependencia externa
// ---------------------------------------------------------------------------

function uuidV5(nome, namespace) {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const hash = crypto.createHash('sha1')
    .update(ns)
    .update(Buffer.from(nome, 'utf8'))
    .digest();

  const b = Buffer.from(hash.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x50;  // versao 5
  b[8] = (b[8] & 0x3f) | 0x80;  // variante RFC 4122

  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Id deterministico de uma linha filha. */
const idDerivado = (tenantId, tabela, pk) =>
  uuidV5(`${tenantId}:${tabela}:${pk}`, NAMESPACE);

// ---------------------------------------------------------------------------
// Utilitarios
// ---------------------------------------------------------------------------

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has('--dry-run');
const PURGE_SEED = args.has('--purge-seed');

const log  = (...a) => console.log(...a);
const erro = (msg) => { console.error(`\n  ERRO: ${msg}\n`); process.exit(1); };

/**
 * Expressao SQL que entrega TIMESTAMPTZ a partir de uma coluna de data da
 * origem, seja ela com ou sem fuso.
 *
 * TZ_ORIGEM entra como literal e nao como parametro: e constante nossa, do
 * topo do arquivo, nunca dado vindo do banco.
 */
const exprData = (coluna, tipo) =>
  tipo === 'timestamp without time zone'
    ? `${coluna} at time zone '${TZ_ORIGEM}'`
    : coluna;

/**
 * Conecta com erro identificavel. Mostra usuario, host e tamanho da senha —
 * senha truncada na hora de copiar e a causa mais comum de
 * "password authentication failed", e o tamanho denuncia isso sem expor o valor.
 */
async function conectar(cliente, rotulo, connectionString) {
  let descricao = rotulo;
  try {
    const u = new URL(connectionString);
    descricao = `${rotulo}: usuario '${decodeURIComponent(u.username)}' em ` +
                `${u.hostname}:${u.port || 5432}, senha de ${u.password.length} char(s)`;
  } catch {
    erro(`${rotulo} nao e uma URL valida`);
  }

  try {
    await cliente.connect();
  } catch (e) {
    erro(`falhou ao conectar em ${descricao}\n  ${e.message}`);
  }
}

async function colunasDe(cliente, tabela) {
  const { rows } = await cliente.query(
    `select column_name, data_type
       from information_schema.columns
      where table_schema = 'public' and table_name = $1
      order by ordinal_position`,
    [tabela],
  );
  if (rows.length === 0) erro(`tabela public.${tabela} nao existe na origem`);
  return rows;
}

// ---------------------------------------------------------------------------
// Preflight — falha cedo e alto, antes de escrever qualquer coisa
// ---------------------------------------------------------------------------

async function preflight(origem, destino) {
  log('\n== Preflight ==');

  const docs = await colunasDe(origem, 'documentos');
  const nomesDocs = docs.map(c => c.column_name);
  const faltando = COLUNAS_DOCUMENTOS.filter(c => !nomesDocs.includes(c));
  if (faltando.length) {
    erro(`documentos sem as colunas: ${faltando.join(', ')}\n` +
         `  Colunas encontradas: ${nomesDocs.join(', ')}`);
  }
  log(`  documentos: ${nomesDocs.join(', ')}`);
  const tipoCriadoEmDocs = docs.find(c => c.column_name === 'criado_em').data_type;

  const contatos = await colunasDe(origem, 'contatos_chatwoot');
  const nomesContatos = contatos.map(c => c.column_name);
  const faltandoMapa = Object.values(MAPA_CONVERSAS).filter(c => !nomesContatos.includes(c));
  if (faltandoMapa.length) {
    erro(`contatos_chatwoot nao tem: ${faltandoMapa.join(', ')}\n` +
         `  Colunas encontradas: ${nomesContatos.join(', ')}\n` +
         `  Ajuste MAPA_CONVERSAS no topo deste arquivo.`);
  }
  log(`  contatos_chatwoot: ${nomesContatos.join(', ')}`);

  // Dimensao do embedding: 1536 dos dois lados, senao o insert falha linha a linha
  const { rows: [dim] } = await origem.query(
    `select vector_dims(embedding) as d from public.documentos
      where embedding is not null limit 1`,
  );
  if (!dim) erro('nenhum documento com embedding na origem');
  if (dim.d !== DIMENSAO_ESPERADA) {
    erro(`embedding da origem tem ${dim.d} dimensoes, esperado ${DIMENSAO_ESPERADA}`);
  }
  log(`  embedding: ${dim.d} dimensoes`);

  const { rows: [c1] } = await origem.query('select count(*)::int n from public.documentos');
  log(`  origem: ${c1.n} documentos`);

  /*
   * documentos nao tem account_id — nao ha como saber pelo schema se as 12
   * linhas sao todas da conta 56. Se o metadata carregar algum marcador de
   * conta ou tenant, ele aparece aqui e permite conferir a olho.
   */
  const { rows: chaves } = await origem.query(
    `select k, count(*)::int n
       from public.documentos, jsonb_object_keys(metadata) k
      group by k order by k`,
  );
  log(`  chaves em documentos.metadata:`);
  if (chaves.length === 0) {
    log(`    (metadata vazio em todas as linhas)`);
  }
  for (const c of chaves) log(`    ${c.k} (${c.n} linha(s))`);

  const { rows: [amostraMeta] } = await origem.query(
    `select metadata::text as m from public.documentos order by id limit 1`,
  );
  log(`    amostra: ${(amostraMeta?.m ?? '').slice(0, 200)}`);

  // 'fonte' identifica o documento de origem de cada chunk. Vira a coluna
  // origem no destino, que e o que permite reprocessar um documento sem
  // duplicar os chunks dele (secao 7).
  const { rows: fontes } = await origem.query(
    `select coalesce(metadata->>'fonte', '(sem fonte)') as fonte, count(*)::int n
       from public.documentos group by 1 order by 1`,
  );
  log(`  documentos por fonte:`);
  for (const f of fontes) log(`    ${f.fonte} (${f.n} chunk(s))`);

  /*
   * contatos_chatwoot tem account_id proprio: a origem nao e necessariamente
   * single-tenant. Importar a tabela inteira jogaria conversa de outra conta
   * dentro do tenant da Acqua — contaminacao cruzada logo na carga inicial.
   * Filtra por account_id e mostra o que ficou de fora.
   */
  const { rows: contas } = await origem.query(
    `select account_id, count(*)::int n from public.contatos_chatwoot
     group by account_id order by account_id`,
  );
  log(`  contatos_chatwoot por account_id:`);
  for (const c of contas) {
    const marca = c.account_id === CHATWOOT_ACCOUNT_ID ? '<- importa' : '   ignora';
    log(`    ${String(c.account_id).padStart(6)}: ${String(c.n).padStart(4)} linha(s)  ${marca}`);
  }

  const daConta = contas.find(c => c.account_id === CHATWOOT_ACCOUNT_ID);
  if (!daConta) {
    erro(`nenhuma linha em contatos_chatwoot com account_id = ${CHATWOOT_ACCOUNT_ID}`);
  }
  const totalContatos = daConta.n;

  /*
   * Status nao mapeado aborta aqui, antes de escrever qualquer coisa.
   */
  const { rows: statuses } = await origem.query(
    `select distinct status from public.contatos_chatwoot
      where account_id = $1 and status is not null order by status`,
    [CHATWOOT_ACCOUNT_ID],
  );
  const naoMapeados = statuses.map(s => s.status).filter(s => !(s in MAPA_STATUS));
  if (naoMapeados.length) {
    erro(`status sem mapeamento: ${naoMapeados.map(s => `'${s}'`).join(', ')}\n` +
         `  Valores na origem: ${statuses.map(s => `'${s.status}'`).join(', ')}\n` +
         `  Preencha MAPA_STATUS no topo deste arquivo. Nao vou adivinhar:\n` +
         `  mapear errado faz conversa encerrada voltar como ativa em producao.`);
  }
  log(`  status encontrados: ${statuses.map(s => `'${s.status}'`).join(', ') || '(nenhum)'}`);

  /*
   * Fuso: as colunas da origem sao TIMESTAMP sem fuso. Confira se as datas
   * abaixo batem com o esperado; deslocamento de horas aqui vira deslocamento
   * de horas na "ultima atividade" do painel.
   */
  const { rows: [tz] } = await origem.query('show timezone');
  const { rows: [datas] } = await origem.query(
    `select max(criado_em)::text as ultima, now()::text as agora
       from public.contatos_chatwoot where account_id = $1`,
    [CHATWOOT_ACCOUNT_ID],
  );
  log(`  fuso da origem: ${tz.TimeZone ?? tz.timezone} | interpretando datas como ${TZ_ORIGEM}`);
  log(`    ultimo contato: ${datas.ultima}`);
  log(`    now() da origem: ${datas.agora}`);

  // O tenant precisa existir no destino com o chatwoot_account_id certo
  const { rows: [t] } = await destino.query(
    `select id, slug, nome from public.tenants
      where chatwoot_account_id = $1 and deletado_em is null`,
    [CHATWOOT_ACCOUNT_ID],
  );
  if (!t) {
    erro(`nenhum tenant no destino com chatwoot_account_id = ${CHATWOOT_ACCOUNT_ID}.\n` +
         `  Crie o tenant antes de importar — este script nao inventa tenant.`);
  }
  log(`  destino: tenant ${t.slug} (${t.id})`);

  return { tenantId: t.id, totalDocs: c1.n, totalContatos, tipoCriadoEmDocs };
}

// ---------------------------------------------------------------------------
// Documentos -> kb_documentos
// ---------------------------------------------------------------------------

async function importarDocumentos(origem, destino, tenantId, tipoCriadoEm) {
  log('\n== documentos -> kb_documentos ==');

  /*
   * chunk_index nao existe na origem: o metadata so tem loc.lines.from/to.
   * Deriva pela posicao do chunk dentro da propria fonte, ordenado por id —
   * que e a ordem em que a ingestao gravou. Assim a coluna chunk_index do
   * destino fica utilizavel para remontar o documento na ordem certa.
   */
  const { rows } = await origem.query(
    `select id, text, embedding::text as embedding, metadata,
            ${exprData('criado_em', tipoCriadoEm)} as criado_em,
            (row_number() over (
               partition by metadata->>'fonte' order by id
             ) - 1)::int as chunk_index
       from public.documentos order by id`,
  );

  let escritos = 0;

  for (const r of rows) {
    const id = idDerivado(tenantId, 'documentos', r.id);

    /*
     * O metadata da origem NAO tem tenant_id — verificado: as 12 linhas so
     * trazem blobType, fonte, loc e source. O agente em producao depende do
     * banco ser single-tenant, nao de filtro por metadata. Ou seja: aqui o
     * tenant_id esta sendo acrescentado, nao corrigido, e nenhum filtro
     * existente no n8n quebra por causa disso.
     *
     * api_n8n_buscar_kb filtra pela coluna tenant_id, entao o metadata nao e
     * barreira de seguranca. Continua carregando o tenant_id porque o node
     * PGVector filtra por metadata, e pode voltar a ser usado em algum fluxo.
     */
    const metaOrigem = r.metadata && typeof r.metadata === 'object' ? r.metadata : {};
    const metadata = {
      ...metaOrigem,
      tenant_id: tenantId,
      origem_id: String(r.id),   // rastreabilidade para a linha do banco antigo
    };

    /*
     * 'fonte' antes de 'source': source e "blob" nas 12 linhas, que nao
     * identifica nada. fonte e "atendimento_acqua_ariquemes" — o documento de
     * verdade. E a coluna origem que permite reprocessar um documento
     * deletando so os chunks dele.
     */
    const origemDoc =
      metaOrigem.fonte ?? metaOrigem.origem ?? metaOrigem.source ?? 'import-coolify';

    if (DRY_RUN) { escritos++; continue; }

    await destino.query(
      `insert into public.kb_documentos
         (id, tenant_id, text, embedding, metadata, origem, chunk_index, criado_em)
       values ($1, $2, $3, $4::extensions.vector, $5, $6, $7, $8)
       on conflict (id) do update set
         text        = excluded.text,
         embedding   = excluded.embedding,
         metadata    = excluded.metadata,
         origem      = excluded.origem,
         chunk_index = excluded.chunk_index,
         deletado_em = null`,
      [id, tenantId, r.text, r.embedding, metadata, origemDoc, r.chunk_index, r.criado_em],
    );
    escritos++;
  }

  log(`  ${escritos} documento(s) ${DRY_RUN ? 'seriam gravados' : 'gravados'}`);
  return escritos;
}

// ---------------------------------------------------------------------------
// contatos_chatwoot -> conversas
// ---------------------------------------------------------------------------

async function importarConversas(origem, destino, tenantId) {
  log('\n== contatos_chatwoot -> conversas ==');

  const m = MAPA_CONVERSAS;

  /*
   * "at time zone $2" converte TIMESTAMP -> TIMESTAMPTZ interpretando o valor
   * no fuso da origem, em vez de deixar o driver assumir o fuso da sessao.
   * Filtro por account_id: ver preflight.
   */
  const { rows } = await origem.query(
    `select ${m.conversation_id}                     as conversation_id,
            ${m.contact_name}                        as contact_name,
            ${m.phone}                               as phone,
            ${m.status}                              as status,
            ${m.pausado_em} at time zone $2          as pausado_em,
            ${m.criado_em}  at time zone $2          as criado_em
       from public.contatos_chatwoot
      where account_id = $1
      order by ${m.conversation_id}`,
    [CHATWOOT_ACCOUNT_ID, TZ_ORIGEM],
  );

  let escritos = 0;
  let semId = 0;

  for (const r of rows) {
    if (r.conversation_id === null) { semId++; continue; }

    const id = idDerivado(tenantId, 'contatos_chatwoot', r.conversation_id);

    // O preflight ja abortou se houvesse status fora do mapa; nulo cai em
    // 'ativo', que e o default da coluna no destino.
    const status = r.status === null ? 'ativo' : MAPA_STATUS[r.status];

    // Coerencia: pausado_em so faz sentido com status 'pausado'.
    const pausadoEm = status === 'pausado' ? r.pausado_em : null;

    if (DRY_RUN) { escritos++; continue; }

    await destino.query(
      `insert into public.conversas
         (id, tenant_id, conversation_id, contact_name, phone, status, pausado_em, criado_em)
       values ($1, $2, $3, $4, $5, $6, $7, coalesce($8, now()))
       on conflict (tenant_id, conversation_id) do update set
         contact_name  = excluded.contact_name,
         phone         = excluded.phone,
         status        = excluded.status,
         pausado_em    = excluded.pausado_em,
         atualizado_em = now()`,
      [id, tenantId, r.conversation_id, r.contact_name, r.phone, status, pausadoEm, r.criado_em],
    );
    escritos++;
  }

  log(`  ${escritos} conversa(s) ${DRY_RUN ? 'seriam gravadas' : 'gravadas'}`);
  if (semId) log(`  ${semId} linha(s) sem conversation_id ignorada(s)`);
  return escritos;
}

// ---------------------------------------------------------------------------
// Verificacao pos-carga
// ---------------------------------------------------------------------------

async function verificar(origem, destino, tenantId, esperado) {
  log('\n== Verificacao ==');
  let falhas = 0;

  const conferir = (nome, obtido, alvo) => {
    const ok = obtido === alvo;
    log(`  ${ok ? 'OK  ' : 'FALHA'} ${nome}: ${obtido} (esperado ${alvo})`);
    if (!ok) falhas++;
  };

  const { rows: [d] } = await destino.query(
    `select count(*)::int n from public.kb_documentos
      where tenant_id = $1 and origem <> 'seed' and deletado_em is null`,
    [tenantId],
  );
  conferir('documentos importados', d.n, esperado.docs);

  const { rows: [c] } = await destino.query(
    `select count(*)::int n from public.conversas where tenant_id = $1`,
    [tenantId],
  );
  conferir('conversas importadas', c.n, esperado.conversas);

  // Toda linha com 1536 dimensoes
  const { rows: [dim] } = await destino.query(
    `select count(*)::int n from public.kb_documentos
      where tenant_id = $1 and vector_dims(embedding) <> $2`,
    [tenantId, DIMENSAO_ESPERADA],
  );
  conferir('linhas com dimensao errada', dim.n, 0);

  // Todo metadata com o tenant_id novo
  const { rows: [meta] } = await destino.query(
    `select count(*)::int n from public.kb_documentos
      where tenant_id = $1 and coalesce(metadata->>'tenant_id', '') <> $1::text`,
    [tenantId],
  );
  conferir('metadata sem tenant_id correto', meta.n, 0);

  /*
   * Paridade de recall: pega o embedding de um documento real da origem,
   * busca nos dois bancos e compara o texto do primeiro resultado.
   *
   * Contagem igual nao prova que os vetores chegaram intactos — um erro de
   * serializacao produz 12 linhas com numeros errados e a contagem passa.
   * O que pega isso e a busca devolver a mesma coisa dos dois lados.
   */
  const { rows: [amostra] } = await origem.query(
    `select embedding::text as embedding from public.documentos
      where embedding is not null order by id limit 1`,
  );

  const { rows: topOrigem } = await origem.query(
    `select text from public.documentos
      where embedding is not null
      order by embedding <=> $1::vector limit 3`,
    [amostra.embedding],
  );

  const { rows: topDestino } = await destino.query(
    `select text from public.kb_documentos
      where tenant_id = $1 and origem <> 'seed' and deletado_em is null
      order by embedding <=> $2::extensions.vector limit 3`,
    [tenantId, amostra.embedding],
  );

  const iguais =
    topOrigem.length === topDestino.length &&
    topOrigem.every((r, i) => r.text === topDestino[i]?.text);

  log(`  ${iguais ? 'OK  ' : 'FALHA'} paridade de recall (top 3 identico)`);
  if (!iguais) {
    falhas++;
    log('    origem : ' + topOrigem.map(r => (r.text ?? '').slice(0, 50)).join(' | '));
    log('    destino: ' + topDestino.map(r => (r.text ?? '').slice(0, 50)).join(' | '));
  }

  return falhas;
}

// ---------------------------------------------------------------------------

async function main() {
  if (!process.env.PROD_DB_URL)     erro('PROD_DB_URL nao definida');
  if (!process.env.SUPABASE_DB_URL) erro('SUPABASE_DB_URL nao definida');

  const origem  = new pg.Client({ connectionString: process.env.PROD_DB_URL });
  const destino = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL });

  /*
   * Conecta uma de cada vez, dizendo qual falhou. Sao dois bancos e o Postgres
   * devolve a mesma mensagem para os dois ("password authentication failed for
   * user X") — sem o rotulo, nao da para saber onde mexer.
   */
  await conectar(origem, 'PROD_DB_URL (Coolify)', process.env.PROD_DB_URL);
  await conectar(destino, 'SUPABASE_DB_URL', process.env.SUPABASE_DB_URL);

  // A origem e producao viva: garante que nada aqui consegue escrever nela.
  await origem.query('set session characteristics as transaction read only');

  log(DRY_RUN ? '\nMODO DRY-RUN — nada sera gravado' : '\nMODO GRAVACAO');

  try {
    const { tenantId, totalDocs, totalContatos, tipoCriadoEmDocs } =
      await preflight(origem, destino);

    if (!DRY_RUN) await destino.query('begin');

    if (PURGE_SEED) {
      const { rowCount } = DRY_RUN
        ? { rowCount: 0 }
        : await destino.query(
            `delete from public.kb_documentos where tenant_id = $1 and origem = 'seed'`,
            [tenantId],
          );
      log(`\n== Purge do seed ==\n  ${rowCount} documento(s) de seed removido(s)`);
    }

    const docs = await importarDocumentos(origem, destino, tenantId, tipoCriadoEmDocs);
    const convs = await importarConversas(origem, destino, tenantId);

    if (!DRY_RUN) await destino.query('commit');

    if (DRY_RUN) {
      log(`\nDry-run concluido: ${docs} documentos e ${convs} conversas seriam importados.`);
      log('Rode sem --dry-run para gravar.\n');
      return;
    }

    const falhas = await verificar(origem, destino, tenantId, {
      docs: totalDocs,
      conversas: totalContatos,
    });

    if (falhas > 0) {
      erro(`${falhas} verificacao(oes) falharam. NAO faca o cutover do n8n.`);
    }

    log('\nCarga concluida e verificada.');
    log('Proximo passo: docs/n8n-cutover.md\n');
  } catch (e) {
    if (!DRY_RUN) await destino.query('rollback').catch(() => {});
    throw e;
  } finally {
    await origem.end();
    await destino.end();
  }
}

main().catch((e) => {
  console.error('\n  FALHOU:', e.message);
  process.exit(1);
});
