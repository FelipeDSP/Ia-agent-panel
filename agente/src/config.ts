/**
 * Configuração do agente — tudo vem do ambiente do container (Coolify).
 * Nada de segredo em código nem em tabela (DESENHO §1).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Config {
  /** Conexão do role `n8n_agent` — NUNCA a de `postgres`. */
  dbUrl: string;
  porta: number;
  /** Identidade deste processo na fila (`reivindicada_por`). */
  workerId: string;
  /** Token que faz parte da URL do webhook: `/chatwoot/<token>/<inbox>`. */
  webhookToken: string;
  /** Segredo do endpoint `POST /limpar-memoria` (o painel manda `x-limpeza-secret`). */
  limpezaSecret: string;
  /** OpenAI: modelo, embeddings (KB) e transcrição. */
  openaiApiKey: string;
  /** O `x-foto-secret` da Edge Function `foto-produto`; sem ele a tool de foto recusa com motivo próprio. */
  fotoSecret: string | null;
  /** Ingestão na base (aprendizado automático, 01/10): a Edge Function e o segredo dela. */
  supabaseUrl: string | null;
  ingestaoSecret: string | null;
  /**
   * O modelo que LÊ o atendimento no aprendizado automático. Separado do
   * modelo do atendimento (que é por tenant, em `tenants.modelo`): aqui é
   * leitura em lote, fora do caminho da resposta, e o barato serve.
   */
  modeloAprendizado: string;
  /** Pasta com os corpos JS do n8n que continuam sendo fonte (extrair, filtro). */
  /** Onde moram as regras `.js` que o serviço executa (ex-`n8n/`, desde 05/10 `agente/regras`). */
  regrasDir: string;
  waha: { url: string; apiKey: string } | null;
  /** Token de USUÁRIO admin da agência no Chatwoot (uma credencial, todas as contas): abre a conversa do aviso ao dono. Opcional. */
  chatwootAgenciaToken: string | null;
  /** Quantas linhas o worker reivindica por ciclo, e o intervalo do ciclo. */
  loteFila: number;
  intervaloFilaMs: number;
  leaseMinutos: number;
  retencaoDias: number;
  /** Alarme de agente mudo: minutos sem saída depois de uma entrada, por tenant em `codigo`. */
  mudoMinutos: number;
  versaoCodigo: string;
  /** A política de retenção (67); defaults em RETENCAO_PADRAO. */
  retencao: { textoDias: number; turnosDias: number; contagemDias: number; conversasDias: number };
}

const AQUI = path.dirname(fileURLToPath(import.meta.url));

function obrigatorio(nome: string): string {
  const v = process.env[nome];
  if (!v || !v.trim()) throw new Error(`config: falta a variável de ambiente ${nome}`);
  return v.trim();
}
function inteiro(nome: string, padrao: number): number {
  const v = process.env[nome];
  if (v === undefined || v === '') return padrao;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`config: ${nome} tem de ser inteiro >= 0, veio "${v}"`);
  return n;
}

function versaoDoCodigo(env: NodeJS.ProcessEnv): string {
  const explicita = env.VERSAO_CODIGO?.trim();
  if (explicita && explicita !== 'dev') return explicita;
  const commit = env.SOURCE_COMMIT?.trim();
  return commit ? commit.slice(0, 12) : 'dev';
}

export function lerConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dbUrl = obrigatorio('AGENTE_DB_URL');
  // A conexão do agente é a do role restrito. Um `postgres@` aqui daria ao
  // processo BYPASSRLS e todas as tabelas — a regra 5 do CLAUDE.md em outra roupa.
  if (/^postgres(ql)?:\/\/postgres[:@]/i.test(dbUrl)) {
    throw new Error('config: AGENTE_DB_URL não pode ser o usuário postgres; use o role n8n_agent');
  }
  const wahaUrl = env.WAHA_URL?.trim();
  const wahaKey = env.WAHA_API_KEY?.trim();
  return {
    dbUrl,
    porta: inteiro('PORT', 3100),
    workerId: env.WORKER_ID?.trim() || `agente-${process.pid}`,
    webhookToken: obrigatorio('WEBHOOK_TOKEN'),
    limpezaSecret: obrigatorio('LIMPEZA_SECRET'),
    openaiApiKey: obrigatorio('OPENAI_API_KEY'),
    fotoSecret: env.FOTO_SECRET?.trim() || null,
    supabaseUrl: env.SUPABASE_URL?.trim() || null,
    ingestaoSecret: env.INGESTAO_SECRET?.trim() || null,
    modeloAprendizado: env.MODELO_APRENDIZADO?.trim() || 'gpt-4.1-mini',
    // 05/10: a pasta `n8n/` foi apagada e os arquivos que o serviço EXECUTA
    // (portão, extrator do webhook, consolidação da busca) passaram para
    // `agente/regras`. `REGRAS_DIR` manda; `N8N_JS_DIR` continua lido para o
    // deploy que ainda a tiver no Coolify, e QUALQUER um dos dois só vale se o
    // diretório existir de fato — apontar para `/app/n8n`, que não existe mais,
    // derrubaria o portão em produção no primeiro turno.
    regrasDir: primeiroDirValido([env.REGRAS_DIR?.trim(), env.N8N_JS_DIR?.trim(), path.resolve(AQUI, '..', 'regras')]),
    waha: wahaUrl && wahaKey ? { url: wahaUrl.replace(/\/+$/, ''), apiKey: wahaKey } : null,
    chatwootAgenciaToken: env.CHATWOOT_AGENCIA_TOKEN?.trim() || null,
    loteFila: inteiro('FILA_LOTE', 10),
    intervaloFilaMs: inteiro('FILA_INTERVALO_MS', 1000),
    leaseMinutos: inteiro('FILA_LEASE_MIN', 5),
    retencaoDias: inteiro('TRACE_RETENCAO_DIAS', 30),
    mudoMinutos: inteiro('MUDO_MINUTOS', 10),
    // VERSAO_CODIGO explícita vence; 'dev' é o default da imagem (ARG SOURCE_COMMIT
    // não passado no build) e conta como ausente — aí vale o SOURCE_COMMIT que o
    // Coolify injeta no AMBIENTE do container (16/09: o build arg não chegou; /saude
    // saiu 'dev'). Só então 'dev'.
    versaoCodigo: versaoDoCodigo(env),
    retencao: {
      textoDias: inteiro('RETENCAO_TEXTO_DIAS', 45),
      turnosDias: inteiro('RETENCAO_TURNOS_DIAS', 45),
      contagemDias: inteiro('RETENCAO_CONTAGEM_DIAS', 400),
      conversasDias: inteiro('RETENCAO_CONVERSAS_DIAS', 180),
    },
  };
}

/**
 * O primeiro diretório da lista que EXISTE e tem as regras dentro.
 *
 * Não basta "a variável está definida": em 05/10 a pasta `n8n/` foi apagada e
 * `N8N_JS_DIR=/app/n8n` pode ter sobrado no Coolify. Aceitar o caminho sem
 * conferir deixaria o serviço subir e quebrar no primeiro turno, dentro do
 * portão — o lugar mais caro possível. Conferir custa um `statSync`.
 */
function primeiroDirValido(candidatos: (string | undefined)[]): string {
  const marca = 'aplica-portao.js';
  for (const dir of candidatos) {
    if (!dir) continue;
    try { if (fs.statSync(path.join(dir, marca)).isFile()) return dir; } catch { /* próximo */ }
  }
  const ultimo = candidatos.filter(Boolean).at(-1);
  throw new Error(`regras do agente não encontradas (${marca}) em: ${candidatos.filter(Boolean).join(', ') || '(nenhum caminho)'}${ultimo ? '' : ''}`);
}
