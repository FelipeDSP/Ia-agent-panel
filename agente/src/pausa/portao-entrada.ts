/**
 * `Consulta Pausa` + `Nao Pausada?` + `Anomalia?` + `Notifica Anomalia WAHA`.
 *
 * A decisão inteira é do BANCO (`api_n8n_portao_mensagem`, migração 53): se a
 * conversa está pausada (humano, manual, ou anomalia de laço) e, no caso da
 * anomalia, para quem avisar. O código só faz duas coisas: não enfileira, e
 * manda o aviso por WAHA quando a função pede — com `onError: continue`, como
 * no n8n: o aviso falhar não pode derrubar o descarte.
 */
import { fnUma, type Db } from '../db.ts';
import type { Waha } from '../waha/notificar.ts';

export interface PortaoMensagem {
  pausada: boolean;
  motivo: string | null;
  anomalia: boolean;
  sessao: string | null;
  destino: string | null;
  mensagem: string | null;
}

export async function portaoEntrada(db: Db, waha: Waha | null, tenantId: string, conversationId: number): Promise<{ segue: boolean; portao: PortaoMensagem; avisoWaha?: 'enviado' | 'falhou' | 'sem_waha' }> {
  const p = await fnUma<PortaoMensagem>(db, 'api_n8n_portao_mensagem', [tenantId, conversationId]);
  if (!p) throw new Error('api_n8n_portao_mensagem devolveu vazio');
  if (p.pausada !== true) return { segue: true, portao: p };

  let avisoWaha: 'enviado' | 'falhou' | 'sem_waha' | undefined;
  if (p.anomalia === true && p.sessao && p.destino && p.mensagem) {
    if (!waha) avisoWaha = 'sem_waha';
    else {
      try { await waha.enviarTexto(p.sessao, p.destino, p.mensagem); avisoWaha = 'enviado'; }
      catch { avisoWaha = 'falhou'; }
    }
  }
  return { segue: false, portao: p, avisoWaha };
}
