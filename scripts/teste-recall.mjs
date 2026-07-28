// Teste de recall da base de conhecimento (Fase 4).
//
// Mede o que build e typecheck nao medem: se o que foi vetorizado e
// ENCONTRAVEL. Para cada pergunta, gera o embedding (mesma OpenAI, mesmo
// modelo do pipeline) e chama api_n8n_buscar_kb com o tenant — exatamente o
// caminho que o agente no n8n percorre. Depois confere se o trecho esperado
// voltou no topo.
//
// Se o chunking ou o metadata estiver errado, a busca volta vazia ou
// irrelevante sem erro nenhum. Este script transforma esse silencio em falha.
//
// Uso (PowerShell):
//   $env:OPENAI_API_KEY = "sk-..."
//   $env:SUPABASE_DB_URL = "postgres://postgres.<ref>:SENHA@aws-0-sa-east-1.pooler.supabase.com:5432/postgres"
//   node scripts/teste-recall.mjs --tenant sandbox --perguntas scripts/perguntas-exemplo.json
//
// perguntas.json: [{ "pergunta": "...", "espera": "substring que deve aparecer no topo" }]
//
// Conecta como postgres (dono das funcoes), entao pode executar api_n8n_buscar_kb
// sem o role n8n_agent. E o mesmo SQL que o n8n roda.

import { readFileSync } from 'node:fs';

import pg from 'pg';

const MODELO = 'text-embedding-3-small';
const TOP_K = 5;

function arg(nome, padrao) {
  const i = process.argv.indexOf(`--${nome}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : padrao;
}

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_DB_URL = process.env.SUPABASE_DB_URL;
const TENANT_SLUG = arg('tenant');
const ARQUIVO_PERGUNTAS = arg('perguntas');

function abortar(msg) {
  console.error(`\n  ERRO: ${msg}\n`);
  process.exit(1);
}

if (!OPENAI_API_KEY) abortar('defina OPENAI_API_KEY no ambiente.');
if (!SUPABASE_DB_URL) abortar('defina SUPABASE_DB_URL no ambiente.');
if (!TENANT_SLUG) abortar('passe --tenant <slug>.');
if (!ARQUIVO_PERGUNTAS) abortar('passe --perguntas <arquivo.json>.');

const perguntas = JSON.parse(readFileSync(ARQUIVO_PERGUNTAS, 'utf-8'));
if (!Array.isArray(perguntas) || perguntas.length === 0) {
  abortar('arquivo de perguntas vazio ou nao e um array.');
}

async function embeddar(texto) {
  const resp = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: MODELO, input: texto }),
  });
  if (!resp.ok) abortar(`OpenAI ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  const data = await resp.json();
  return data.data[0].embedding;
}

const client = new pg.Client({ connectionString: SUPABASE_DB_URL });

async function main() {
  await client.connect();

  const { rows: trows } = await client.query(
    'select id, nome from public.tenants where slug = $1 and ativo and deletado_em is null',
    [TENANT_SLUG],
  );
  if (trows.length === 0) abortar(`tenant '${TENANT_SLUG}' nao encontrado ou inativo.`);
  const tenantId = trows[0].id;

  const { rows: crows } = await client.query(
    'select count(*)::int as n from public.kb_documentos where tenant_id = $1 and deletado_em is null',
    [tenantId],
  );
  console.log(`\nTenant: ${trows[0].nome} (${tenantId})`);
  console.log(`Chunks ativos na base: ${crows[0].n}\n`);
  if (crows[0].n === 0) abortar('a base deste tenant esta vazia — ingira um documento antes.');

  let passaram = 0;

  for (const [i, p] of perguntas.entries()) {
    const emb = await embeddar(p.pergunta);
    const literal = JSON.stringify(emb); // [0.1,0.2,...] — literal de vector

    const { rows } = await client.query(
      'select id, text, similarity from api_n8n_buscar_kb($1::uuid, $2::vector, $3::int)',
      [tenantId, literal, TOP_K],
    );

    const espera = (p.espera ?? '').toLowerCase();
    const topo = rows[0];
    const achouNoTopo =
      topo && espera && topo.text.toLowerCase().includes(espera);
    const achouEmAlgum =
      espera && rows.some((r) => r.text.toLowerCase().includes(espera));

    const marca = achouNoTopo ? 'OK  ' : achouEmAlgum ? 'MEIO' : 'FALHA';
    if (achouNoTopo) passaram += 1;

    console.log(`[${marca}] Q${i + 1}: ${p.pergunta}`);
    if (espera) console.log(`        espera conter: "${p.espera}"`);
    rows.slice(0, 3).forEach((r, k) => {
      const sim = Number(r.similarity).toFixed(3);
      const trecho = r.text.replace(/\s+/g, ' ').slice(0, 90);
      console.log(`        #${k + 1} sim=${sim} ${trecho}…`);
    });
    if (!achouNoTopo && achouEmAlgum) {
      console.log('        (apareceu, mas nao no topo — chunking pode melhorar)');
    }
    console.log('');
  }

  console.log(`Resultado: ${passaram}/${perguntas.length} com o trecho certo no topo.\n`);
  await client.end();

  // So passa se TODAS baterem no topo.
  process.exit(passaram === perguntas.length ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
