/**
 * O caminho de ÁUDIO, em código:
 *   Config Audio (`api_n8n_pode_transcrever`) -> Audio Contratado? -> Audio
 *   Curto? (file_size <= limite_bytes) -> Baixa Anexo (data_url, com o token
 *   do Chatwoot) -> Transcreve (whisper-1, verbose_json, pt) -> Filtra
 *   Transcricao (`filtra-transcricao.js`, o MESMO corpo do n8n, com o filtro
 *   de injection injetado) -> ok | bloqueado | vazio.
 *
 * Os avisos ao cliente (mídia não suportada, áudio longo, falhou) são os
 * textos por tenant que a função devolve — quem envia é o turno.
 */
import { fnUma, type Db } from '../db.ts';
import { corpoN8n, rodarN8n } from '../n8n-js.ts';

export interface Anexo { file_type: string | null; data_url: string | null; file_size: number; extensao: string }

export interface Transcritor {
  /** Devolve o `verbose_json` da OpenAI: { text, duration, usage: { seconds } }. */
  transcrever(arquivo: Uint8Array, nome: string): Promise<Record<string, unknown>>;
}

export interface ConfigAudio { tool_ativa: boolean; conversa_pausada: boolean; chatwoot_url: string | null; chatwoot_token: string | null; limite_bytes: number | null; msg_audio_longo: string | null; msg_audio_falhou: string | null }

export type ResultadoTranscricao =
  | { status: 'ok'; mensagem: string; audioSegundos: number | null; diagnostico: Record<string, unknown> }
  | { status: 'bloqueado' | 'vazio'; motivo: string; audioSegundos: number | null }
  | { status: 'nao_contratado' | 'longo' | 'falhou'; avisoAoCliente: string | null; erro?: string };

export async function transcreverAnexo(p: { db: Db; n8nJsDir: string; tenantId: string; conversationId: number; anexo: Anexo; transcritor: Transcritor | null; fetchFn: typeof fetch; msgMidiaNaoSuportada: string | null }): Promise<ResultadoTranscricao> {
  const cfg = await fnUma<ConfigAudio>(p.db, 'api_n8n_pode_transcrever', [p.tenantId, p.conversationId]);
  if (!cfg || cfg.tool_ativa !== true || !p.transcritor) return { status: 'nao_contratado', avisoAoCliente: p.msgMidiaNaoSuportada };
  if (p.anexo.file_type !== 'audio' || !p.anexo.data_url) return { status: 'nao_contratado', avisoAoCliente: p.msgMidiaNaoSuportada };
  if (cfg.limite_bytes !== null && p.anexo.file_size > Number(cfg.limite_bytes)) return { status: 'longo', avisoAoCliente: cfg.msg_audio_longo };

  try {
    // Timeout explícito: download pendurado não pode segurar o turno (e o lease da
    // fila) por minutos — o cliente fica sem resposta e o alarme de mudo dispara.
    const r = await p.fetchFn(p.anexo.data_url, { headers: cfg.chatwoot_token ? { api_access_token: cfg.chatwoot_token } : {}, signal: AbortSignal.timeout(30_000) });
    if (!r.ok) throw new Error(`baixar anexo -> HTTP ${r.status}`);
    const bytes = new Uint8Array(await r.arrayBuffer());
    // A extensão vem da URL (o campo `extension` veio nulo no payload real):
    // a API de transcrição decide o parser pelo nome do arquivo.
    const nome = `audio.${p.anexo.extensao || 'oga'}`;
    const resposta = await p.transcritor.transcrever(bytes, nome);
    const saida = rodarN8n(corpoN8n(p.n8nJsDir, 'filtra-transcricao.js', { injetarFiltro: true }), { json: resposta }, {
      'Extrair e Filtrar': { anexo: p.anexo },
    });
    const audioSegundos = typeof saida.audio_segundos === 'number' ? saida.audio_segundos : null;
    if (saida.status === 'ok') {
      return { status: 'ok', mensagem: String(saida.mensagem ?? ''), audioSegundos, diagnostico: { fonte: saida._duracao_fonte, real: saida._duracao_real, file_size: saida._file_size } };
    }
    return { status: saida.status === 'bloqueado' ? 'bloqueado' : 'vazio', motivo: String(saida.motivo ?? ''), audioSegundos };
  } catch (e) {
    return { status: 'falhou', avisoAoCliente: cfg.msg_audio_falhou, erro: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
  }
}
