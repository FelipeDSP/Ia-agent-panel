/**
 * `Tool - Transferir para Humano`, em código:
 *   Busca Config (`api_n8n_config_tool(t,'transferir_humano')`) -> Avalia Horario
 *   -> [ativa E disponível] Nota Privada no Chatwoot -> Pausa Agente
 *      (`api_n8n_definir_status_conversa` 'pausado', onError continue)
 *      -> [canal waha] Notifica WAHA (onError continue) -> TRANSFERIDO
 *   -> senão FORA_DO_HORARIO
 *
 * O horário é a lógica do nó `Avalia Horario`, portada: `Intl` no fuso do
 * tenant (dias `dias_semana`, `hora_inicio`..`hora_fim`), defaults 1–5, 8–18,
 * America/Sao_Paulo. Textos de retorno verbatim.
 */
import { fnUma, fnValor } from '../db.ts';
import type { FerramentaDoModelo } from '../agente/modelo.ts';
import type { ConfigTool, ContextoTool } from './contexto.ts';

export const DESCRICAO = 'Use esta ferramenta quando o cliente solicitar explicitamente para falar com um atendente humano, ou quando você não conseguir responder à pergunta após buscar na base de conhecimento.';
export const TEXTO_TRANSFERIDO = 'TRANSFERIDO: um atendente humano foi notificado e assumirá a conversa. Informe ao cliente que a transferência foi realizada e que aguarde o atendimento.';
export const TEXTO_FORA_DO_HORARIO = 'FORA_DO_HORARIO: não há atendente disponível neste momento. Informe ao cliente o horário de atendimento e ofereça ajuda com outras dúvidas enquanto isso.';

interface Horario { timezone?: string; dias_semana?: number[]; hora_inicio?: number; hora_fim?: number }
interface Notificacao { canal?: string; sessao?: string; destino?: string }

export function disponivelAgora(horario: Horario | undefined, agora = new Date()): { disponivel: boolean; debug: Record<string, unknown> } {
  const h = horario ?? {};
  const tz = h.timezone || 'America/Sao_Paulo';
  const dias = Array.isArray(h.dias_semana) ? h.dias_semana : [1, 2, 3, 4, 5];
  const ini = Number.isFinite(h.hora_inicio) ? Number(h.hora_inicio) : 8;
  const fim = Number.isFinite(h.hora_fim) ? Number(h.hora_fim) : 18;
  const partes = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', hour12: false }).formatToParts(agora).map((p) => [p.type, p.value]));
  const mapa: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const diaSemana = mapa[partes.weekday ?? ''] ?? -1;
  const hora = parseInt(partes.hour ?? '0', 10) % 24;
  const diaOk = dias.includes(diaSemana);
  const horaOk = hora >= ini && hora < fim;
  return { disponivel: diaOk && horaOk, debug: { tz, diaSemana, hora, diaOk, horaOk } };
}

export async function transferirHumano(ctx: ContextoTool, resumo: string): Promise<{ resultado: string; disponivel: boolean; notificou: 'waha' | 'nenhum' | 'falhou'; pausou: boolean | null }> {
  const cfg = await fnUma<ConfigTool>(ctx.db, 'api_n8n_config_tool', [ctx.tenant.tenant_id, 'transferir_humano']);
  const config = (cfg?.config ?? {}) as { horario?: Horario; notificacao?: Notificacao };
  const { disponivel } = disponivelAgora(config.horario);
  const ativa = cfg?.tool_ativa !== false;
  if (!(ativa && disponivel)) return { resultado: TEXTO_FORA_DO_HORARIO, disponivel, notificou: 'nenhum', pausou: null };

  // Nota privada com o resumo (o que o atendente lê), depois pausa, depois avisa.
  await ctx.chatwoot.enviar({ tenantId: ctx.tenant.tenant_id, conversationId: ctx.conversationId, content: '🤖 *Resumo do atendimento via bot:*\n\n' + resumo, privada: true });
  // onError: continue, como no n8n — mas o trace fica sabendo se a pausa entrou.
  let pausou = false;
  try { pausou = (await fnValor<string>(ctx.db, 'api_n8n_definir_status_conversa', [ctx.tenant.tenant_id, ctx.conversationId, 'pausado'])) === 'pausado'; } catch { pausou = false; }
  const n = config.notificacao ?? { canal: 'nenhum' };
  let notificou: 'waha' | 'nenhum' | 'falhou' = 'nenhum';
  if (n.canal === 'waha' && n.sessao && n.destino) {
    if (!ctx.waha) notificou = 'falhou';
    else {
      try {
        await ctx.waha.enviarTexto(n.sessao, n.destino, `🔔 *Novo atendimento solicitado!*\n\n💬 *Assunto:* ${resumo}\n\nO cliente solicita atendimento humano.`);
        notificou = 'waha';
      } catch { notificou = 'falhou'; }
    }
  }
  return { resultado: TEXTO_TRANSFERIDO, disponivel, notificou, pausou };
}

export function ferramentaTransferirHumano(ctx: ContextoTool): FerramentaDoModelo {
  return {
    nome: 'transferir_humano',
    descricao: DESCRICAO,
    parametros: {
      type: 'object',
      properties: { resumo: { type: 'string', description: 'Resumo claro do que foi conversado, para o atendente que vai assumir.' } },
      required: ['resumo'],
      additionalProperties: false,
    },
    executar: async (args) => {
      const r = await transferirHumano(ctx, String(args.resumo ?? ''));
      return { texto: r.resultado, diagnostico: { disponivel: r.disponivel, pausou: r.pausou, notificou: r.notificou } };
    },
  };
}
