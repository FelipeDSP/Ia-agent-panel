/**
 * O que acontece com UM webhook do Chatwoot — o caminho do n8n até o
 * `Acumula Mensagem`, em ordem:
 *
 *   classificar -> [humano] humanoAssumiu (pausa + descarta pendentes)
 *               -> [cliente] extrair -> resolverTenant (+ runtime) -> portaoEntrada
 *                            -> [processar|midia|bloqueado] enfileirar
 *                            -> [ignorar] nada
 *
 * Responde ao Chatwoot em qualquer caso (o HTTP faz isso, fora daqui). Tudo
 * que NÃO enfileira volta com um `motivo`, e o receptor loga o motivo — é a
 * única visibilidade de "por que o agente não respondeu" antes de existir um
 * turno no trace.
 *
 * A caixa da URL tem de ser a caixa do corpo: um webhook apontado para
 * `/chatwoot/<token>/282` com `conversation.inbox_id = 279` é configuração
 * errada ou forja, e nos dois casos a resposta certa é não atender.
 */
import type { Db } from '../db.ts';
import type { Waha } from '../waha/notificar.ts';
import { classificar, type WebhookChatwoot } from './classificar.ts';
import { extrair, type Extraido } from './extrair.ts';
import { resolverTenant } from '../tenant/resolver.ts';
import { portaoEntrada } from '../pausa/portao-entrada.ts';
import { humanoAssumiu } from '../pausa/humano-assumiu.ts';
import { fnValor } from '../db.ts';
import { log, erroTexto } from '../log.ts';

export interface Recebido {
  evento: 'cliente' | 'humano' | 'descartar';
  resultado: 'enfileirada' | 'ignorada' | 'pausada_na_entrada' | 'pausou' | 'nota_interna' | 'caixa_divergente' | 'tenant' | 'descartada' | 'escutada';
  motivo?: string;
  filaId?: string;
  descartadas?: number;
  tenantSlug?: string;
  extraido?: Extraido;
}

export interface Deps { db: Db; waha: Waha | null; regrasDir: string }

export async function receber(deps: Deps, inboxDaUrl: number | null, body: WebhookChatwoot): Promise<Recebido> {
  const evento = classificar(body);
  if (evento === 'descartar') return { evento, resultado: 'descartada', motivo: 'evento_nao_roteado' };

  if (evento === 'humano') {
    const r = await humanoAssumiu(deps.db, body as Parameters<typeof humanoAssumiu>[1]);
    return { evento, resultado: r.acao === 'pausou' ? 'pausou' : r.acao === 'nota_interna' ? 'nota_interna' : 'tenant', motivo: r.acao, ...(r.descartadas ? { descartadas: r.descartadas } : {}) };
  }

  const ex = extrair(deps.regrasDir, body);
  if (inboxDaUrl !== null && ex.chatwoot_inbox_id !== inboxDaUrl) {
    return { evento, resultado: 'caixa_divergente', motivo: `url=${inboxDaUrl} corpo=${ex.chatwoot_inbox_id}`, extraido: ex };
  }
  const res = await resolverTenant(deps.db, ex.chatwoot_account_id, ex.chatwoot_inbox_id);
  if (!res.ok) {
    // MODO ESCUTA (01/10). Agente desligado + aprendizado ligado: a mensagem do
    // cliente é GRAVADA e nada mais acontece — não enfileira, não responde, não
    // avisa. É o que o Felipe pediu: a equipe atende normalmente por uma
    // semana e, quando o agente for ligado, ele já chega sabendo. Sem o botão,
    // o descarte é o de sempre (nem o texto fica).
    //
    // Só o caminho `agente_inativo`: tenant desconhecido ou em outro runtime
    // continua sendo descarte seco — gravar conversa de quem não é nosso seria
    // guardar dado alheio.
    if (res.motivo === 'agente_inativo' && res.tenant && ex.conversation_id !== null) {
      const escutou = await escutarDesligado(deps, res.tenant.tenant_id, ex, body);
      if (escutou) return { evento, resultado: 'escutada', motivo: 'agente_inativo', tenantSlug: res.tenant.slug, extraido: ex };
    }
    return { evento, resultado: 'tenant', motivo: res.motivo, tenantSlug: res.tenant?.slug, extraido: ex };
  }
  const { tenant } = res;

  if (ex.acao === 'ignorar') return { evento, resultado: 'ignorada', motivo: ex.motivo, tenantSlug: tenant.slug, extraido: ex };
  if (ex.conversation_id === null) return { evento, resultado: 'ignorada', motivo: 'sem_conversation_id', tenantSlug: tenant.slug, extraido: ex };

  const portao = await portaoEntrada(deps.db, deps.waha, tenant.tenant_id, ex.conversation_id);
  if (!portao.segue) {
    return { evento, resultado: 'pausada_na_entrada', motivo: `${portao.portao.motivo ?? 'pausada'}${portao.avisoWaha ? `/waha:${portao.avisoWaha}` : ''}`, tenantSlug: tenant.slug, extraido: ex };
  }

  // O que vai para a fila é o que o turno precisa e NADA mais. Nome e telefone
  // entram porque o `Sync Conversa` do turno os grava em `conversas` (como o
  // n8n faz); a fila tem RLS por tenant, e `conversas` já guarda os dois.
  // O corpo bruto do webhook NÃO entra.
  const mensagem = {
    acao: ex.acao, mensagem: ex.mensagem ?? null, anexo: ex.anexo ?? null,
    contact_name: ex.contact_name, phone: ex.phone,
    chatwoot_account_id: ex.chatwoot_account_id, chatwoot_inbox_id: ex.chatwoot_inbox_id,
    message_id: (body as { id?: number }).id ?? null,
  };
  const filaId = await fnValor<string>(deps.db, 'api_agente_enfileirar', [tenant.tenant_id, ex.conversation_id, JSON.stringify(mensagem), tenant.debounce_segundos]);
  return { evento, resultado: 'enfileirada', filaId, tenantSlug: tenant.slug, extraido: ex };
}

/**
 * MODO ESCUTA — grava a fala do cliente com o agente desligado.
 *
 * Existe para o cliente poder "ligar o aprendizado antes de ligar o agente":
 * a equipe atende normalmente e o ciclo da manutenção converte esses
 * atendimentos em base, de modo que o agente chegue sabendo no dia em que for
 * ligado. Até 01/10 a mensagem era descartada em `resolverTenant` e não havia
 * de onde aprender.
 *
 * Três recusas, nesta ordem, e nenhuma é zelo:
 *
 *  - o BOTÃO desligado: sem ele não há autorização para guardar conversa de
 *    quem nem está usando o agente;
 *  - mídia e mensagem vazia: áudio sem transcrição (que só acontece no turno,
 *    e turno não há) não é texto; guardar "[áudio]" é poluir a memória;
 *  - falha ao gravar NÃO sobe: o webhook tem de responder 200 ao Chatwoot de
 *    qualquer jeito, e o cliente não está esperando resposta nenhuma aqui.
 *
 * `execucao_id = 'escuta:<id da mensagem>'` dá a idempotência do índice
 * `uq_mensagens_log_execucao`, como no caminho do atendente.
 */
async function escutarDesligado(
  deps: Deps,
  tenantId: string,
  ex: { conversation_id: number | null; mensagem?: string | null; acao?: string },
  body: Record<string, unknown>,
): Promise<boolean> {
  try {
    if ((await fnValor<boolean>(deps.db, 'api_agente_aprendizado_ligado', [tenantId])) !== true) return false;
    const texto = typeof ex.mensagem === 'string' ? ex.mensagem.trim() : '';
    const id = Number(body['id'] ?? NaN);
    if (!texto || ex.conversation_id === null || !Number.isFinite(id)) return false;
    await fnValor(deps.db, 'api_n8n_registrar_mensagem', [
      tenantId, ex.conversation_id, 'entrada', texto, 0, 0, null, null, `escuta:${id}`,
      JSON.stringify({ fonte: 'escuta', chamadas: 0 }),
    ]);
    return true;
  } catch (e) {
    log('erro', 'escuta.falhou', { tenant: tenantId, conversa: ex.conversation_id, erro: erroTexto(e) });
    return false;
  }
}
