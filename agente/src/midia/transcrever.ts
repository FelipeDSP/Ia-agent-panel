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

/**
 * Download do anexo em DUAS tentativas curtas em vez de uma longa.
 *
 * Medido em 16/09/2026, no sendbox: dois áudios reais penduraram o download
 * (65 s até o TCP desistir; depois 30 s no timeout) enquanto o MESMO URL, com
 * o MESMO token, baixava em 0,4–0,6 s de fora e de dentro do container com um
 * `node -e` avulso. Só o processo do serviço pendurava — e ele é o único que
 * mantém conexões keep-alive abertas com `app.chatyou.chat` entre turnos. O
 * quadro é o de socket ocioso que o outro lado fechou sem o container ver
 * (NAT do Docker): a requisição sai, nada volta. Abortar destrói o socket, e
 * a tentativa seguinte abre outro — por isso a segunda costuma passar.
 */
export async function baixarAnexo(fetchFn: typeof fetch, url: string, token: string | null | undefined, timeoutsMs: number[] = [10_000, 25_000]): Promise<Uint8Array> {
  const erros: string[] = [];
  for (const timeout of timeoutsMs) {
    try {
      const r = await fetchFn(url, { headers: token ? { api_access_token: token } : {}, signal: AbortSignal.timeout(timeout) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return new Uint8Array(await r.arrayBuffer());
    } catch (e) {
      erros.push(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    }
  }
  throw new Error(`baixar anexo falhou em ${timeoutsMs.length} tentativas: ${erros.join(' | ')}`);
}

export async function transcreverAnexo(p: { db: Db; n8nJsDir: string; tenantId: string; conversationId: number; anexo: Anexo; transcritor: Transcritor | null; fetchFn: typeof fetch; msgMidiaNaoSuportada: string | null }): Promise<ResultadoTranscricao> {
  const cfg = await fnUma<ConfigAudio>(p.db, 'api_n8n_pode_transcrever', [p.tenantId, p.conversationId]);
  if (!cfg || cfg.tool_ativa !== true || !p.transcritor) return { status: 'nao_contratado', avisoAoCliente: p.msgMidiaNaoSuportada };
  if (p.anexo.file_type !== 'audio' || !p.anexo.data_url) return { status: 'nao_contratado', avisoAoCliente: p.msgMidiaNaoSuportada };
  if (cfg.limite_bytes !== null && p.anexo.file_size > Number(cfg.limite_bytes)) return { status: 'longo', avisoAoCliente: cfg.msg_audio_longo };

  try {
    const bytes = await baixarAnexo(p.fetchFn, p.anexo.data_url, cfg.chatwoot_token);
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
