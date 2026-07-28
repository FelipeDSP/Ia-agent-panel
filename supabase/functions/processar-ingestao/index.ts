// Edge Function: processar-ingestao
//
// Roda o processamento pesado da Fase 4 perto do banco, fora do timeout da
// Vercel. Recebe { job_id } (e, para tipo 'texto', o proprio texto no corpo),
// baixa/le o conteudo, extrai texto, faz chunk, embedda em lote e no fim chama
// kb_reindex_documento para o swap atomico.
//
// O tenant NUNCA vem do request: e lido da linha do job em jobs_ingestao, que
// so pode ter sido criada pelo dono via RLS no painel. Aqui usamos service_role
// (ignora RLS) so para orquestrar — a autoridade do isolamento e o job.
//
// Chamada apenas pelo servidor do painel, que apresenta o segredo compartilhado
// no header x-ingestao-secret. Sem esse segredo, 401.

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.58.0';
import { extractText, getDocumentProxy } from 'https://esm.sh/unpdf@0.12.1';
import mammoth from 'https://esm.sh/mammoth@1.8.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY')!;
// Segredo compartilhado so entre o servidor do painel e esta funcao. Independe
// do formato das chaves do Supabase (sb_secret_ vs JWT legado). A funcao e
// publicada com verify_jwt = false; este header e o unico portao.
const INGESTAO_SECRET = Deno.env.get('INGESTAO_SECRET')!;

const BUCKET = 'kb-arquivos';
const MODELO_EMBEDDING = 'text-embedding-3-small';
const DIMENSAO = 1536;
const LOTE_EMBEDDING = 20; // chunks por request a OpenAI

// Tamanho do chunk, em caracteres, com override por env para tunar sem
// redeploy de codigo.
//
// O CLAUDE.md fixa alvo ~450 chars (~120 tokens), overlap ~120. Os 12 chunks
// que o n8n ja gravou em producao (origem atendimento_acqua_ariquemes) tem
// media de ~380 chars; como o n8n le o MESMO banco, chunk muito maior quebra a
// paridade de recall (teste da Fase 4: 3/5 com chunk grande vs 5/5 alinhado a
// producao). Ao mexer nestes valores, re-rode o teste de recall.
function envInt(nome: string, padrao: number): number {
  const v = Number(Deno.env.get(nome));
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : padrao;
}
const ALVO_CHARS = envInt('CHUNK_ALVO_CHARS', 450);
// OVERLAP sempre < ALVO: senao o passo do fatiador (ALVO - OVERLAP) fica <= 0 e
// o while do chunker nunca avanca — loop infinito sob env mal configurada.
const OVERLAP_CHARS = Math.min(envInt('CHUNK_OVERLAP_CHARS', 120), ALVO_CHARS - 1);

type Job = {
  id: string;
  tenant_id: string;
  arquivo_nome: string;
  arquivo_path: string | null;
  tipo: 'arquivo' | 'texto';
  status: string;
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ---------------------------------------------------------------------------
// Extracao por formato
// ---------------------------------------------------------------------------

function extensao(nome: string): string {
  const p = nome.toLowerCase().split('.');
  return p.length > 1 ? p[p.length - 1] : '';
}

async function extrairTexto(bytes: Uint8Array, nome: string): Promise<string> {
  const ext = extensao(nome);

  if (ext === 'pdf') {
    const pdf = await getDocumentProxy(bytes);
    const { text } = await extractText(pdf, { mergePages: true });
    const limpo = (Array.isArray(text) ? text.join('\n') : text).trim();
    // PDF escaneado: pdf.js devolve pouquissimo ou nada. OCR esta fora de escopo.
    if (limpo.replace(/\s/g, '').length < 20) {
      throw new Error(
        'PDF parece ser escaneado (imagem). OCR esta fora de escopo — envie um ' +
          'PDF com texto selecionavel.',
      );
    }
    return limpo;
  }

  if (ext === 'docx') {
    const { value } = await mammoth.extractRawText({
      arrayBuffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    });
    return (value ?? '').trim();
  }

  if (ext === 'txt') {
    return new TextDecoder('utf-8').decode(bytes).trim();
  }

  throw new Error(`Formato .${ext} nao suportado. Aceitos: PDF, DOCX, TXT.`);
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

// Normaliza espacos e quebra em blocos por paragrafo; empacota ate ~ALVO_CHARS
// e carrega OVERLAP_CHARS do fim do bloco anterior para o proximo, para nao
// cortar uma ideia no meio da fronteira.
function chunk(texto: string): string[] {
  const normal = texto.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
  if (!normal) return [];

  const paragrafos = normal
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  const pedacos: string[] = [];
  let atual = '';

  const empurrar = () => {
    const t = atual.trim();
    if (t) pedacos.push(t);
  };

  for (const par of paragrafos) {
    // Paragrafo sozinho maior que o alvo: fatia em janelas com overlap.
    if (par.length > ALVO_CHARS) {
      empurrar();
      atual = '';
      let i = 0;
      while (i < par.length) {
        const fim = Math.min(i + ALVO_CHARS, par.length);
        pedacos.push(par.slice(i, fim).trim());
        if (fim >= par.length) break;
        i = fim - OVERLAP_CHARS; // recua para sobrepor
      }
      continue;
    }

    if ((atual + '\n\n' + par).length > ALVO_CHARS && atual) {
      empurrar();
      // proximo chunk comeca com a cauda do anterior (overlap)
      const cauda = atual.slice(Math.max(0, atual.length - OVERLAP_CHARS));
      atual = cauda + '\n\n' + par;
    } else {
      atual = atual ? atual + '\n\n' + par : par;
    }
  }
  empurrar();

  return pedacos.filter((p) => p.replace(/\s/g, '').length > 0);
}

// ---------------------------------------------------------------------------
// Embedding em lote, com retry
// ---------------------------------------------------------------------------

async function embeddarLote(inputs: string[]): Promise<{ vetores: number[][]; tokens: number }> {
  let ultimoErro: unknown;
  for (let tentativa = 1; tentativa <= 3; tentativa++) {
    try {
      const resp = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model: MODELO_EMBEDDING, input: inputs }),
      });
      if (!resp.ok) {
        const txt = await resp.text();
        throw new Error(`OpenAI ${resp.status}: ${txt.slice(0, 300)}`);
      }
      const data = await resp.json();
      const vetores: number[][] = data.data
        .sort((a: { index: number }, b: { index: number }) => a.index - b.index)
        .map((d: { embedding: number[] }) => d.embedding);
      for (const v of vetores) {
        if (v.length !== DIMENSAO) {
          throw new Error(`Embedding com ${v.length} dims, esperado ${DIMENSAO}`);
        }
      }
      // usage.total_tokens alimenta o billing (uso_ingestao). Se a OpenAI nao
      // devolver, cai para 0 — o custo apenas fica subestimado, nunca quebra.
      const tokens = Number(data.usage?.total_tokens ?? 0);
      return { vetores, tokens };
    } catch (e) {
      ultimoErro = e;
      if (tentativa < 3) await new Promise((r) => setTimeout(r, 500 * tentativa));
    }
  }
  throw ultimoErro;
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

async function marcarErro(jobId: string, msg: string) {
  await admin
    .from('jobs_ingestao')
    .update({ status: 'erro', erro_msg: msg.slice(0, 1000), concluido_em: new Date().toISOString() })
    .eq('id', jobId);
}

async function processar(job: Job, textoColado?: string): Promise<void> {
  try {
    await admin
      .from('jobs_ingestao')
      .update({ status: 'processando', chunks_ok: 0, chunks_total: 0, erro_msg: null })
      .eq('id', job.id);

    // 1. Conteudo + origem estavel
    let texto: string;
    let origem: string;

    if (job.tipo === 'texto') {
      texto = (textoColado ?? '').trim();
      origem = `texto:${job.id}`;
      if (!texto) throw new Error('Texto vazio.');
    } else {
      if (!job.arquivo_path) throw new Error('Job de arquivo sem arquivo_path.');
      const { data, error } = await admin.storage.from(BUCKET).download(job.arquivo_path);
      if (error || !data) throw new Error(`Falha ao baixar do Storage: ${error?.message ?? 'sem dados'}`);
      const bytes = new Uint8Array(await data.arrayBuffer());
      texto = await extrairTexto(bytes, job.arquivo_nome);
      origem = job.arquivo_path; // path e a identidade estavel do documento
      if (!texto) throw new Error('Arquivo sem texto extraivel.');
    }

    // 2. Chunk
    const pedacos = chunk(texto);
    if (pedacos.length === 0) throw new Error('Nenhum chunk gerado a partir do conteudo.');

    await admin.from('jobs_ingestao').update({ chunks_total: pedacos.length }).eq('id', job.id);

    // 3. Embedding em lote, atualizando progresso
    const linhas: { text: string; embedding: number[]; chunk_index: number; metadata: unknown }[] = [];
    let feitos = 0;
    let tokensEmbedding = 0;
    for (let i = 0; i < pedacos.length; i += LOTE_EMBEDDING) {
      const lote = pedacos.slice(i, i + LOTE_EMBEDDING);
      const { vetores, tokens } = await embeddarLote(lote);
      tokensEmbedding += tokens;
      lote.forEach((t, j) => {
        const idx = i + j;
        linhas.push({
          text: t,
          embedding: vetores[j],
          chunk_index: idx,
          // tenant_id e fonte sao reescritos pela funcao de swap — nao confiar aqui.
          metadata: { source: job.tipo === 'texto' ? 'texto' : 'upload', arquivo: job.arquivo_nome },
        });
      });
      feitos += lote.length;
      await admin.from('jobs_ingestao').update({ chunks_ok: feitos }).eq('id', job.id);
    }

    // 4. Swap atomico (delete fisico por tenant+origem + insert). A funcao e a
    // autoridade do invariante tenant_id coluna=metadata.
    const { data: inseridos, error: swapErro } = await admin.rpc('kb_reindex_documento', {
      p_tenant_id: job.tenant_id,
      p_origem: origem,
      p_chunks: linhas,
    });
    if (swapErro) throw new Error(`Swap falhou: ${swapErro.message}`);

    // Registra o consumo de embedding para o billing (Fase 5). Best-effort: se
    // falhar, nao derruba a ingestao — o documento ja foi indexado.
    if (tokensEmbedding > 0) {
      const { error: usoErro } = await admin.from('uso_ingestao').insert({
        tenant_id: job.tenant_id,
        modelo: MODELO_EMBEDDING,
        tokens: tokensEmbedding,
        job_id: job.id,
      });
      if (usoErro) console.error('uso_ingestao falhou:', usoErro.message);
    }

    await admin
      .from('jobs_ingestao')
      .update({
        status: 'concluido',
        chunks_ok: (inseridos as number) ?? pedacos.length,
        chunks_total: (inseridos as number) ?? pedacos.length,
        concluido_em: new Date().toISOString(),
      })
      .eq('id', job.id);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await marcarErro(job.id, msg);
    // Nao relanca: o status 'erro' no job ja e o canal de reporte para o painel.
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

// Comparacao de tempo constante do segredo. Timing-attack pela rede e
// impraticavel e o segredo tem alta entropia, mas comparar certo e barato.
// Comparar so quando os tamanhos batem (o tamanho do segredo nao e sensivel).
function segredoConfere(recebido: string | null): boolean {
  if (recebido === null || recebido.length !== INGESTAO_SECRET.length) return false;
  let diff = 0;
  for (let i = 0; i < recebido.length; i++) {
    diff |= recebido.charCodeAt(i) ^ INGESTAO_SECRET.charCodeAt(i);
  }
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ erro: 'Use POST.' }, 405);

  // Portao: so o servidor do painel, que conhece o segredo compartilhado.
  if (!segredoConfere(req.headers.get('x-ingestao-secret'))) {
    return json({ erro: 'Nao autorizado.' }, 401);
  }

  let corpo: { job_id?: string; texto?: string };
  try {
    corpo = await req.json();
  } catch {
    return json({ erro: 'Corpo JSON invalido.' }, 400);
  }
  if (!corpo.job_id) return json({ erro: 'job_id obrigatorio.' }, 400);

  const { data: job, error } = await admin
    .from('jobs_ingestao')
    .select('id, tenant_id, arquivo_nome, arquivo_path, tipo, status')
    .eq('id', corpo.job_id)
    .single();

  if (error || !job) return json({ erro: 'Job nao encontrado.' }, 404);
  if (job.status === 'processando' || job.status === 'concluido') {
    return json({ erro: `Job ja esta '${job.status}'.` }, 409);
  }

  // Texto colado e pequeno: processa sincrono e devolve o resultado.
  if (job.tipo === 'texto') {
    await processar(job as Job, corpo.texto);
    const { data: atual } = await admin
      .from('jobs_ingestao')
      .select('status, chunks_ok, erro_msg')
      .eq('id', job.id)
      .single();
    return json({ ok: atual?.status === 'concluido', job: atual });
  }

  // Arquivo: pode levar 30-60s. Responde ja e segue processando em background.
  EdgeRuntime.waitUntil(processar(job as Job));
  return json({ ok: true, status: 'processando' }, 202);
});
