/**
 * O processo do agente: receptor HTTP + worker da fila + manutenção, no mesmo
 * container. Um só, sem framework, sem Redis (DESENHO §1 e §3b).
 *
 * Desligamento: SIGTERM para de reivindicar, espera o ciclo corrente, fecha o
 * HTTP e o pool. Uma linha da fila que ficou `processando` volta pela lease.
 */
import { lerConfig } from './config.ts';
import { criarPool } from './db.ts';
import { criarServidor } from './entrada/http.ts';
import { carregarExtrair } from './entrada/extrair.ts';
import { criarChatwoot } from './chatwoot/enviar.ts';
import { criarWaha } from './waha/notificar.ts';
import { criarModeloOpenAI } from './agente/modelo.ts';
import { criarEmbeddingsOpenAI, criarTranscritorOpenAI } from './agente/openai-servicos.ts';
import { umCiclo } from './fila/worker.ts';
import { alarmeAgenteMudo, varrerRetencao, encerrarLinksVencidos, aplicarRetencao, RETENCAO_PADRAO } from './manutencao.ts';
import { criarAsaas } from './pagamento/asaas.ts';
import { ENCERRAMENTO } from '../../n8n/tool-pagamento-fonte.mjs';
import { log, erroTexto } from './log.ts';

const cfg = lerConfig();
const pool = criarPool(cfg.dbUrl);
const chatwoot = criarChatwoot(pool);
const waha = cfg.waha ? criarWaha(cfg.waha.url, cfg.waha.apiKey) : null;
const modelo = criarModeloOpenAI(cfg.openaiApiKey);
const embeddings = criarEmbeddingsOpenAI(cfg.openaiApiKey);
const transcritor = criarTranscritorOpenAI(cfg.openaiApiKey);
// Sem chave global: a chave de cada chamada vem da linha do banco do tenant.
const asaas = criarAsaas(fetch);
const alarme = process.env.ALARME_WAHA_SESSAO && process.env.ALARME_WAHA_DESTINO
  ? { sessao: process.env.ALARME_WAHA_SESSAO, destino: process.env.ALARME_WAHA_DESTINO } : null;

// Compila os corpos JS do n8n na subida: se faltarem, o processo não sobe —
// melhor que descobrir no primeiro webhook.
carregarExtrair(cfg.n8nJsDir);

let ultimoCiclo = 0;
let parando = false;

const servidor = criarServidor({
  db: pool, waha, n8nJsDir: cfg.n8nJsDir,
  webhookToken: cfg.webhookToken, limpezaSecret: cfg.limpezaSecret, versaoCodigo: cfg.versaoCodigo, chatwoot,
  filaViva: () => Date.now() - ultimoCiclo < Math.max(cfg.intervaloFilaMs * 5, 15_000),
});
servidor.listen(cfg.porta, () => log('info', 'http.ouvindo', { porta: cfg.porta, worker: cfg.workerId, versao: cfg.versaoCodigo }));

async function lacoDaFila(): Promise<void> {
  while (!parando) {
    try {
      const r = await umCiclo({
        db: pool, chatwoot, waha, modelo, embeddings, transcritor, n8nJsDir: cfg.n8nJsDir, versaoCodigo: cfg.versaoCodigo,
        fotoSecret: cfg.fotoSecret, fetchFn: fetch, asaas, workerId: cfg.workerId, lote: cfg.loteFila, leaseMinutos: cfg.leaseMinutos,
      });
      if (r.reivindicadas > 0) log('info', 'fila.ciclo', { ...r });
    } catch (e) {
      log('erro', 'fila.ciclo_falhou', { erro: erroTexto(e) });
    }
    ultimoCiclo = Date.now();
    await new Promise((r) => setTimeout(r, cfg.intervaloFilaMs));
  }
}

async function lacoDeManutencao(): Promise<void> {
  let ultimaVarredura = 0;
  let ultimoEncerramento = 0;
  const intervaloEncerramentoMs = Number(ENCERRAMENTO.intervalo_minutos ?? 5) * 60_000;
  while (!parando) {
    try {
      await alarmeAgenteMudo({ db: pool, waha, retencaoDias: cfg.retencaoDias, mudoMinutos: cfg.mudoMinutos, alarme });
      // Encerramento dos links de pagamento vencidos (64 / §12), a cada 5 min.
      if (ENCERRAMENTO.obrigatorio === true && Date.now() - ultimoEncerramento >= intervaloEncerramentoMs) {
        const r = await encerrarLinksVencidos({ db: pool, waha, retencaoDias: cfg.retencaoDias, mudoMinutos: cfg.mudoMinutos, alarme, asaas });
        if (r.vencidas > 0) log('info', 'encerramento.varredura', { ...r });
        ultimoEncerramento = Date.now();
      }
      // Retenção 1x por dia, às 04:00 de Brasília (UTC-3 => 07:00Z).
      const agora = new Date();
      if (agora.getUTCHours() === 7 && Date.now() - ultimaVarredura > 20 * 60 * 60 * 1000) {
        await varrerRetencao({ db: pool, waha, retencaoDias: cfg.retencaoDias, mudoMinutos: cfg.mudoMinutos, alarme });
        try {
          await aplicarRetencao({ db: pool, waha, retencaoDias: cfg.retencaoDias, mudoMinutos: cfg.mudoMinutos, alarme, retencao: cfg.retencao });
        } catch (e) {
          log('erro', 'manutencao.retencao_dados_falhou', { erro: erroTexto(e) });
        }
        ultimaVarredura = Date.now();
      }
    } catch (e) {
      log('erro', 'manutencao.falhou', { erro: erroTexto(e) });
    }
    await new Promise((r) => setTimeout(r, 60_000));
  }
}

void lacoDaFila();
void lacoDeManutencao();

async function desligar(sinal: string): Promise<void> {
  if (parando) return;
  parando = true;
  log('info', 'desligando', { sinal });
  await new Promise<void>((r) => servidor.close(() => r()));
  await new Promise((r) => setTimeout(r, cfg.intervaloFilaMs + 500));
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', () => void desligar('SIGTERM'));
process.on('SIGINT', () => void desligar('SIGINT'));
