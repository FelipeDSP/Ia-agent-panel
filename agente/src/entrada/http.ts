/**
 * O receptor HTTP — três rotas, sem framework:
 *
 *   GET  /saude                                  healthcheck do Coolify (200 + fila viva)
 *   POST /chatwoot/<token>/<inbox>               o webhook do Agent Bot; 200 em < 1 s, só enfileira
 *   POST /limpar-memoria                         o botão do painel (header x-limpeza-secret,
 *                                                body { tenant_id, escopo, conversation_ids? })
 *
 * O `<token>` na URL é o que o n8n não tinha: o bot do Chatwoot não manda
 * header nenhum, então a única forma de a URL não ser adivinhável é ela
 * carregar um segredo. Token errado -> 404, sem corpo, sem log de tenant.
 *
 * Responde 200 SEMPRE que o token bate — inclusive quando descarta. Erro de
 * processamento vira 200 + log de erro: o Chatwoot não reenvia, e um 500 só
 * serviria para alguém ler no painel dele, o que ninguém faz.
 */
import http from 'node:http';
import { receber, type Deps as DepsReceber } from './receber.ts';
import { fnValor } from '../db.ts';
import { log, erroTexto } from '../log.ts';

export interface DepsHttp extends DepsReceber {
  webhookToken: string;
  limpezaSecret: string;
  /** Diz se o worker está vivo (última passada há menos de N s). */
  filaViva: () => boolean;
}

const LIMITE_CORPO = 1_000_000;

function lerCorpo(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let dados = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => { dados += c; if (dados.length > LIMITE_CORPO) { reject(new Error('corpo grande demais')); req.destroy(); } });
    req.on('end', () => resolve(dados));
    req.on('error', reject);
  });
}

function responder(res: http.ServerResponse, status: number, corpo?: unknown): void {
  if (corpo === undefined) { res.writeHead(status); res.end(); return; }
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(corpo));
}

export function criarServidor(deps: DepsHttp): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://local');
    const partes = url.pathname.split('/').filter(Boolean);

    if (req.method === 'GET' && partes[0] === 'saude') {
      const viva = deps.filaViva();
      return responder(res, viva ? 200 : 503, { ok: viva, fila: viva ? 'viva' : 'parada' });
    }

    if (req.method === 'POST' && partes[0] === 'chatwoot') {
      const [, token, inboxTxt] = partes;
      const inbox = Number(inboxTxt);
      if (token !== deps.webhookToken || !Number.isInteger(inbox)) return responder(res, 404);
      let body: unknown;
      try { body = JSON.parse(await lerCorpo(req)); } catch { return responder(res, 200, { ok: false, motivo: 'corpo_invalido' }); }
      try {
        const r = await receber(deps, inbox, body as Parameters<typeof receber>[2]);
        log('info', 'webhook', { inbox, evento: r.evento, resultado: r.resultado, motivo: r.motivo, tenant: r.tenantSlug, fila: r.filaId });
        return responder(res, 200, { ok: true, resultado: r.resultado });
      } catch (e) {
        log('erro', 'webhook.falhou', { inbox, erro: erroTexto(e) });
        return responder(res, 200, { ok: false, motivo: 'erro_interno' });
      }
    }

    if (req.method === 'POST' && partes[0] === 'limpar-memoria') {
      if (req.headers['x-limpeza-secret'] !== deps.limpezaSecret) return responder(res, 401, { ok: false });
      let body: { tenant_id?: string; escopo?: string; conversation_ids?: number[] };
      try { body = JSON.parse(await lerCorpo(req)); } catch { return responder(res, 400, { ok: false, motivo: 'corpo_invalido' }); }
      if (!body.tenant_id) return responder(res, 400, { ok: false, motivo: 'tenant_id ausente' });
      // Mesmo contrato do `Limpar Memoria` do n8n: escopo 'conversa' exige ids;
      // 'todas' corta todas as conversas do tenant. Nada é apagado: é o corte.
      const ids = body.escopo === 'todas' ? null : (body.conversation_ids ?? []);
      if (ids !== null && ids.length === 0) return responder(res, 400, { ok: false, motivo: 'escopo conversa exige conversation_ids' });
      try {
        const n = await fnValor<number>(deps.db, 'api_agente_memoria_cortar_tenant', [body.tenant_id, ids]);
        log('info', 'limpar_memoria', { tenant: body.tenant_id, cortadas: n });
        return responder(res, 200, { ok: true, apagadas: Number(n ?? 0) });
      } catch (e) {
        log('erro', 'limpar_memoria.falhou', { erro: erroTexto(e) });
        return responder(res, 500, { ok: false });
      }
    }

    return responder(res, 404);
  });
}
