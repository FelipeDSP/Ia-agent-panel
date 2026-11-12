/**
 * ABERTURA EXTERNA (90) — a saída que não é "um atendente assumiu".
 *
 * Um sistema de prospecção manda a primeira mensagem pelo WhatsApp Web, no
 * mesmo número do cliente. O eco chega como `outgoing` de atendente e o ramo
 * `humano` pausa a conversa e descarta a fila dela — exatamente na janela em
 * que o lead responde. A reserva é o sistema externo dizendo, ANTES de enviar,
 * que a próxima saída para aquele telefone é dele.
 *
 * DUAS PROPRIEDADES QUE ESTE ARQUIVO PRECISA GARANTIR, e que o teste afirma:
 *
 *   - SEM RESERVA, NADA MUDA. `consultar` devolve `null` e o chamador segue o
 *     caminho de hoje. Vale para `emporio`, `ceejaar`, `acqua` e todo tenant
 *     que não usa isto;
 *   - FALHA É FECHADA. Qualquer erro aqui — banco fora, função ausente porque a
 *     migração não subiu, telefone num formato inesperado — vira `null`, que
 *     significa PAUSAR, o comportamento de hoje. O caminho de pausa é a defesa
 *     de quatro clientes pagantes; ele não pode depender desta funcionalidade
 *     estar de pé.
 *
 * O TEXTO VEM DA RESERVA, não do eco. O eco do fromMe pode chegar sem
 * `content` (foi a suspeita que abriu este trabalho), e gravar a partir dele
 * seria depender justamente do campo duvidoso.
 */
import { fnTodas, fnValor, type Db } from '../db.ts';
import { log, erroTexto } from '../log.ts';

/** Minutos em que a reserva cobre as saídas daquele telefone. */
export const JANELA_MIN = 10;

export interface Abertura {
  id: string;
  /** O texto a gravar como `saida` — só na PRIMEIRA saída da janela. */
  texto: string | null;
  contexto: unknown;
}

/** Só dígitos, que é como a reserva e o webhook se encontram. */
export function digitos(valor: unknown): string {
  return typeof valor === 'string' ? valor.replace(/\D/g, '') : '';
}

/**
 * Há reserva viva para este telefone? Devolve `null` quando não há — e também
 * quando qualquer coisa dá errado, de propósito (ver o cabeçalho).
 */
export async function consultar(
  db: Db,
  tenantId: string,
  telefone: string,
  conversationId: number,
): Promise<Abertura | null> {
  const tel = digitos(telefone);
  if (!tel) return null;
  try {
    const linhas = await fnTodas<{ id: string; texto: string | null; contexto: unknown }>(
      db, 'api_agente_abertura_consumir', [tenantId, tel, conversationId, JANELA_MIN],
    );
    const r = linhas[0];
    return r ? { id: r.id, texto: r.texto, contexto: r.contexto } : null;
  } catch (e) {
    log('erro', 'abertura.consulta_falhou', { tenant: tenantId, conversa: conversationId, erro: erroTexto(e) });
    return null;
  }
}

/** Cria a reserva. Idempotente por (tenant, telefone, texto) no banco. */
export async function reservar(
  db: Db,
  p: { tenantId: string; telefone: string; texto: string; contexto?: unknown },
): Promise<string> {
  return fnValor<string>(db, 'api_agente_abertura_reservar', [
    p.tenantId, digitos(p.telefone), p.texto,
    p.contexto === undefined || p.contexto === null ? null : JSON.stringify(p.contexto),
  ]);
}
