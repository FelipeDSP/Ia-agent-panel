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
 * Download do anexo: ESPERAR O ARQUIVO EXISTIR, com tentativas que falham
 * rápido — não uma requisição longa que pendura.
 *
 * Medido em 16/09/2026 no sendbox, em três áudios reais: o Chatwoot dispara o
 * webhook com a `data_url` do anexo **~26 s ANTES** de o arquivo estar no
 * storage dele (S3 `Last-Modified` = webhook + 26–27 s, nos três). Nesse
 * intervalo a URL `…/blobs/proxy/…` que ele manda SEGURA a conexão em vez de
 * responder erro — e, uma vez pendurada, não destrava nem quando o arquivo
 * chega. A variante `…/blobs/redirect/…` do MESMO blob responde na hora com
 * 302 para o S3, e o S3 devolve 404 honesto enquanto não tem o objeto.
 *
 * Então: troca-se `proxy` por `redirect`, segue-se ao storage SEM o token (a
 * URL assinada não precisa dele e o token não deve sair do Chatwoot), e
 * repete-se a cada `intervaloMs` até o 200 ou o prazo. Se a instância não
 * tiver a rota `redirect` (outra versão do Chatwoot), cai no `proxy` com
 * timeout curto por tentativa.
 *
 * O n8n nunca viu isso porque em agosto o Chatwoot mandava a `redirect`
 * (docs em `extrair-e-filtrar.js`); a instância passou a mandar `proxy`.
 */
export interface OpcoesDownload { prazoMs?: number; intervaloMs?: number; timeoutTentativaMs?: number; agora?: () => number; dormir?: (ms: number) => Promise<void> }
export interface Baixado { bytes: Uint8Array; tentativas: number; esperaMs: number; via: 'redirect' | 'proxy' | 'direto' }

export async function baixarAnexo(fetchFn: typeof fetch, url: string, token: string | null | undefined, o: OpcoesDownload = {}): Promise<Baixado> {
  const prazo = o.prazoMs ?? 75_000;
  const intervalo = o.intervaloMs ?? 3_000;
  const timeout = o.timeoutTentativaMs ?? 8_000;
  const agora = o.agora ?? Date.now;
  const dormir = o.dormir ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const cabecalho = token ? { api_access_token: token } : {};

  const ehProxy = url.includes('/blobs/proxy/');
  let via: Baixado['via'] = ehProxy ? 'redirect' : 'direto';
  const inicio = agora();
  const erros: string[] = [];
  let tentativas = 0;

  while (true) {
    tentativas++;
    try {
      if (via === 'redirect') {
        const r = await fetchFn(url.replace('/blobs/proxy/', '/blobs/redirect/'), { headers: cabecalho, redirect: 'manual', signal: AbortSignal.timeout(timeout) });
        const destino = r.headers.get('location');
        if (r.status >= 300 && r.status < 400 && destino) {
          const s = await fetchFn(destino, { signal: AbortSignal.timeout(timeout) });
          if (s.ok) return { bytes: new Uint8Array(await s.arrayBuffer()), tentativas, esperaMs: agora() - inicio, via };
          erros.push(`storage HTTP ${s.status}`);           // 404 = ainda não existe; 403 = URL venceu
        } else if (r.ok) {
          return { bytes: new Uint8Array(await r.arrayBuffer()), tentativas, esperaMs: agora() - inicio, via };
        } else {
          // sem rota `redirect` nesta instância: daqui em diante, `proxy` com timeout curto.
          erros.push(`redirect HTTP ${r.status}`);
          via = 'proxy';
        }
      } else {
        const r = await fetchFn(url, { headers: cabecalho, signal: AbortSignal.timeout(timeout) });
        if (r.ok) return { bytes: new Uint8Array(await r.arrayBuffer()), tentativas, esperaMs: agora() - inicio, via };
        erros.push(`HTTP ${r.status}`);
      }
    } catch (e) {
      erros.push(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    }
    if (agora() - inicio + intervalo > prazo) break;
    await dormir(intervalo);
  }
  throw new Error(`baixar anexo falhou em ${tentativas} tentativas / ${Math.round((agora() - inicio) / 1000)} s: ${[...new Set(erros)].join(' | ')}`);
}

export async function transcreverAnexo(p: { db: Db; n8nJsDir: string; tenantId: string; conversationId: number; anexo: Anexo; transcritor: Transcritor | null; fetchFn: typeof fetch; msgMidiaNaoSuportada: string | null }): Promise<ResultadoTranscricao> {
  const cfg = await fnUma<ConfigAudio>(p.db, 'api_n8n_pode_transcrever', [p.tenantId, p.conversationId]);
  if (!cfg || cfg.tool_ativa !== true || !p.transcritor) return { status: 'nao_contratado', avisoAoCliente: p.msgMidiaNaoSuportada };
  if (p.anexo.file_type !== 'audio' || !p.anexo.data_url) return { status: 'nao_contratado', avisoAoCliente: p.msgMidiaNaoSuportada };
  if (cfg.limite_bytes !== null && p.anexo.file_size > Number(cfg.limite_bytes)) return { status: 'longo', avisoAoCliente: cfg.msg_audio_longo };

  try {
    const baixado = await baixarAnexo(p.fetchFn, p.anexo.data_url, cfg.chatwoot_token);
    const bytes = baixado.bytes;
    // A extensão vem da URL (o campo `extension` veio nulo no payload real):
    // a API de transcrição decide o parser pelo nome do arquivo.
    const nome = `audio.${p.anexo.extensao || 'oga'}`;
    const resposta = await p.transcritor.transcrever(bytes, nome);
    const saida = rodarN8n(corpoN8n(p.n8nJsDir, 'filtra-transcricao.js', { injetarFiltro: true }), { json: resposta }, {
      'Extrair e Filtrar': { anexo: p.anexo },
    });
    const audioSegundos = typeof saida.audio_segundos === 'number' ? saida.audio_segundos : null;
    if (saida.status === 'ok') {
      return { status: 'ok', mensagem: String(saida.mensagem ?? ''), audioSegundos, diagnostico: { fonte: saida._duracao_fonte, real: saida._duracao_real, file_size: saida._file_size, download: { tentativas: baixado.tentativas, espera_ms: baixado.esperaMs, via: baixado.via } } };
    }
    return { status: saida.status === 'bloqueado' ? 'bloqueado' : 'vazio', motivo: String(saida.motivo ?? ''), audioSegundos };
  } catch (e) {
    return { status: 'falhou', avisoAoCliente: cfg.msg_audio_falhou, erro: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
  }
}
