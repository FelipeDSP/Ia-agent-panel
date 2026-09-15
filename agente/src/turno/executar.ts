/**
 * UM TURNO — o que o worker faz depois de `api_agente_turno_da_conversa`
 * dizer 'responder'. Fatia 1: SEM modelo, resposta fixa. A forma é a do n8n
 * do `Sync Conversa` em diante, e cada passo vai para o trace:
 *
 *   sync conversa -> (portão de entrada de novo: a pausa pode ter chegado
 *   durante o debounce) -> resposta -> envia ao Chatwoot -> registra no log
 *
 * O que muda de comportamento na fatia 1, e está declarado:
 *   - `midia` (áudio) NÃO é transcrita: responde `msg_midia_nao_suportada` do
 *     tenant. A transcrição entra na fatia 2 (`midia/`);
 *   - `bloqueado` responde `msg_fora_escopo`, como o n8n;
 *   - `processar` responde um texto FIXO que diz que é a fatia 1. É o que
 *     prova o caminho inteiro sem gastar um token.
 *
 * `Registra Mensagem` grava entrada e saída como o n8n (mesma função, mesma
 * assinatura), com `execucao_id = turno_id` — é a ponte entre `mensagens_log`
 * e o trace. Tokens 0 porque não houve modelo; `portao` fica nulo porque não
 * houve portão — o critério do experimento trata nulo como `sem_veredito`,
 * de propósito.
 */
import { fnUma, fnValor, type Db } from '../db.ts';
import type { Chatwoot } from '../chatwoot/enviar.ts';
import type { Waha } from '../waha/notificar.ts';
import type { Tenant } from '../tenant/resolver.ts';
import { portaoEntrada } from '../pausa/portao-entrada.ts';
import { Turno } from '../trace.ts';

export interface MensagemDaFila {
  acao: 'processar' | 'midia' | 'bloqueado';
  mensagem: string | null;
  anexo: { file_type: string | null; data_url: string | null; file_size: number; extensao: string } | null;
  contact_name: string;
  phone: string | null;
  chatwoot_account_id: number | null;
  chatwoot_inbox_id: number | null;
  message_id: number | null;
}

export interface Deps { db: Db; chatwoot: Chatwoot; waha: Waha | null; versaoCodigo: string }

export interface ResultadoTurno {
  status: 'ok' | 'descartado' | 'falhou';
  turnoId: string;
  motivo?: string;
  resposta?: string;
}

export const TEXTO_FATIA_1 = (n: number) =>
  `[agente em código — fatia 1] Recebi ${n === 1 ? 'sua mensagem' : `suas ${n} mensagens`}. `
  + 'Ainda não estou respondendo de verdade por aqui: este é o caminho novo sendo testado.';

export async function executarTurno(deps: Deps, p: { tenant: Tenant; conversationId: number; filaIds: string[]; mensagens: MensagemDaFila[] }): Promise<ResultadoTurno> {
  const { db } = deps;
  const { tenant, conversationId, mensagens } = p;
  const primeira = mensagens[0];
  if (!primeira) throw new Error('turno sem mensagens');
  const acao = mensagens.some((m) => m.acao === 'bloqueado') ? 'bloqueado'
    : mensagens.every((m) => m.acao === 'midia') ? 'midia' : 'processar';

  const turno = await Turno.abrir(db, {
    tenantId: tenant.tenant_id, conversationId, filaId: p.filaIds[0] ?? null,
    acao, perfil: null, modelo: null, promptHash: null,
  });
  await turno.passo('entrada', 'mensagens', { entrada: { quantidade: mensagens.length, acoes: mensagens.map((m) => m.acao), fila_ids: p.filaIds } });

  try {
    // Sync Conversa — cria/atualiza a conversa com nome e telefone, como o n8n.
    await turno.medir('registro', 'api_n8n_conversa_sync', { conversationId },
      () => fnUma(db, 'api_n8n_conversa_sync', [tenant.tenant_id, conversationId, primeira.contact_name, primeira.phone]));

    // A pausa pode ter chegado DURANTE o debounce (humano assumiu): o n8n morre
    // em "corrida"; aqui o turno é descartado em silêncio, e fica no trace.
    const portao = await turno.medir('portao', 'api_n8n_portao_mensagem', { conversationId },
      () => portaoEntrada(db, deps.waha, tenant.tenant_id, conversationId), (r) => r.portao);
    if (!portao.segue) {
      await turno.fechar({ status: 'descartado', erro: `pausada: ${portao.portao.motivo ?? ''}` });
      return { status: 'descartado', turnoId: turno.id, motivo: 'pausada_no_turno' };
    }

    // A resposta da fatia 1.
    const textoEntrada = mensagens.map((m) => m.mensagem ?? (m.acao === 'midia' ? '[mídia]' : '')).filter(Boolean).join('\n');
    const resposta = acao === 'bloqueado' ? (tenant.msg_fora_escopo ?? 'Não posso ajudar com isso.')
      : acao === 'midia' ? (tenant.msg_midia_nao_suportada ?? 'Ainda não consigo ouvir áudio por aqui. Pode escrever?')
        : TEXTO_FATIA_1(mensagens.length);
    await turno.passo('modelo', 'fatia-1-sem-modelo', { entrada: { acao, texto: textoEntrada }, saida: { texto: resposta } });

    // Envia ao Chatwoot — antes de registrar, como o n8n (Envia -> Registra).
    const envio = await turno.medir('envio', 'chatwoot.messages', { conversationId, chars: resposta.length },
      () => deps.chatwoot.enviar({ tenantId: tenant.tenant_id, conversationId, content: resposta }));

    // Registra Mensagem: entrada e saída, mesma função do n8n. Este NÃO é
    // `continue`: falhar aqui é falhar o turno (a regra do README sobre log).
    // Sem transcrição na fatia 1, não há segundos cobrados a ratear.
    const audio: number | null = null;
    const ids = await turno.medir('registro', 'api_n8n_registrar_mensagem', { conversationId }, async () => {
      const entradaId = await fnValor<string>(db, 'api_n8n_registrar_mensagem',
        [tenant.tenant_id, conversationId, 'entrada', textoEntrada, 0, 0, tenant.modelo, audio, turno.id, null]);
      const saidaId = await fnValor<string>(db, 'api_n8n_registrar_mensagem',
        [tenant.tenant_id, conversationId, 'saida', resposta, 0, 0, tenant.modelo, null, turno.id,
          JSON.stringify({ fatia: 1, versao_codigo: deps.versaoCodigo, chatwoot_message_id: envio.mensagemId })]);
      return { entradaId, saidaId };
    });

    await turno.fechar({ status: 'ok', usageEntrada: 0, usageSaida: 0, chamadasModelo: 0, toolsChamadas: 0, mensagensLogSaidaId: ids.saidaId });
    return { status: 'ok', turnoId: turno.id, resposta };
  } catch (e) {
    const erro = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    await turno.fechar({ status: 'falhou', erro });
    return { status: 'falhou', turnoId: turno.id, motivo: erro };
  }
}
