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
 *
 * 21/09 — TIMES (docs/ESPEC-TRANSFERIR-PARA-TIME.md, que o n8n nunca ligou):
 * quando o cliente cadastrou times no painel (`tenant_times`, migrações 44/45;
 * `api_n8n_times` só devolve os VERIFICADOS — id inexistente desatribui a
 * conversa em silêncio), o modelo recebe a lista com as descrições numa seção
 * do prompt e ganha o parâmetro `time`; a tool escolhe (`escolherTime`) e
 * atribui pelo Chatwoot depois da nota privada. Sem time cadastrado, nada
 * muda: a conversa fica sem atribuição, como sempre.
 */
import { fnTodas, fnUma, fnValor, type Db } from '../db.ts';
import { mandarAoDono } from '../pedido/aviso.ts';
import { situacao } from '../tenant/horario.ts';
import { lerHorarioDoAgente } from '../tenant/horario-db.ts';
import type { FerramentaDoModelo } from '../agente/modelo.ts';
import type { ConfigTool, ContextoTool } from './contexto.ts';

export const DESCRICAO = 'Use esta ferramenta quando o cliente solicitar explicitamente para falar com um atendente humano, ou quando você não conseguir responder à pergunta após buscar na base de conhecimento.';
export const TEXTO_TRANSFERIDO = 'TRANSFERIDO: um atendente humano foi notificado e assumirá a conversa. Informe ao cliente que a transferência foi realizada e que aguarde o atendimento.';
export const TEXTO_FORA_DO_HORARIO = 'FORA_DO_HORARIO: não há atendente disponível neste momento. Informe ao cliente o horário de atendimento e ofereça ajuda com outras dúvidas enquanto isso.';

interface Horario { timezone?: string; dias_semana?: number[]; hora_inicio?: number; hora_fim?: number }

export interface TimeDoChatwoot { team_id: number; nome: string; descricao: string; padrao: boolean }

/** Os times VERIFICADOS do tenant (a função de banco já filtra o selo). */
export async function lerTimes(db: Db, tenantId: string): Promise<TimeDoChatwoot[]> {
  const linhas = await fnTodas<{ team_id: number | string; nome: string; descricao: string | null; padrao: boolean }>(db, 'api_n8n_times', [tenantId]);
  return linhas.map((l) => ({ team_id: Number(l.team_id), nome: String(l.nome ?? '').trim(), descricao: String(l.descricao ?? '').trim(), padrao: l.padrao === true }))
    .filter((t) => Number.isFinite(t.team_id) && t.nome !== '');
}

const chave = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

/**
 * Qual time recebe a conversa. Puro, para o teste.
 *   - nome pedido bate (sem acento/caixa) → esse;
 *   - senão o padrão; senão, se só há um, ele; senão nenhum (fica sem
 *     atribuição, que é o comportamento de antes — nunca "chuta" um time).
 */
export function escolherTime(times: TimeDoChatwoot[], pedido: string | null | undefined): TimeDoChatwoot | null {
  if (times.length === 0) return null;
  const p = chave(String(pedido ?? ''));
  if (p) { const t = times.find((x) => chave(x.nome) === p); if (t) return t; }
  return times.find((x) => x.padrao) ?? (times.length === 1 ? times[0]! : null);
}

/** A seção do prompt (por tenant — o wrapper fixo é o do n8n, byte a byte). */
export function secaoTimes(times: TimeDoChatwoot[]): string {
  if (times.length === 0) return '';
  const linhas = times.map((t) => `- "${t.nome}"${t.padrao ? ' (padrão)' : ''}${t.descricao ? `: ${t.descricao}` : ''}`);
  return '## Times de atendimento (transferir_humano)\n'
    + 'Ao transferir, informe em `time` o nome do time que melhor atende o assunto, pelo que o cliente descreveu:\n'
    + linhas.join('\n') + '\n'
    + 'Sem certeza, não informe `time` — o padrão recebe. Nunca invente nome de time.\n\n';
}
interface Notificacao { canal?: string; sessao?: string; destino?: string }
/** 18/09: `horario_da_loja` = "há atendente" segue o horário de atendimento da loja (74); sem loja com horário, sempre. */

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

export type Atribuicao = { time: { id: number; nome: string } } | 'nenhum' | 'nao_encontrado' | 'falhou';

export async function transferirHumano(ctx: ContextoTool, resumo: string, timePedido: string | null = null): Promise<{ resultado: string; disponivel: boolean; notificou: 'waha' | 'chatwoot' | 'nenhum' | 'falhou'; pausou: boolean | null; atribuiu: Atribuicao }> {
  const cfg = await fnUma<ConfigTool>(ctx.db, 'api_n8n_config_tool', [ctx.tenant.tenant_id, 'transferir_humano']);
  const config = (cfg?.config ?? {}) as { horario?: Horario; notificacao?: Notificacao; horario_da_loja?: boolean };
  const disponivel = config.horario_da_loja === true
    ? situacao(await lerHorarioDoAgente(ctx.db, ctx.tenant.tenant_id), ctx.agora?.() ?? new Date()).aberto
    : disponivelAgora(config.horario, ctx.agora?.() ?? new Date()).disponivel;
  const ativa = cfg?.tool_ativa !== false;
  if (!(ativa && disponivel)) return { resultado: TEXTO_FORA_DO_HORARIO, disponivel, notificou: 'nenhum', pausou: null, atribuiu: 'nenhum' };

  // Nota privada com o resumo (o que o atendente lê), depois pausa, depois avisa.
  await ctx.chatwoot.enviar({ tenantId: ctx.tenant.tenant_id, conversationId: ctx.conversationId, content: '🤖 *Resumo do atendimento via bot:*\n\n' + resumo, privada: true });
  // 21/09: o time, se o cliente cadastrou. Falha aqui não derruba a transferência
  // (a nota já está lá e a pausa vem a seguir); o trace fica sabendo.
  let atribuiu: Atribuicao = 'nenhum';
  const time = escolherTime(await lerTimes(ctx.db, ctx.tenant.tenant_id).catch(() => []), timePedido);
  if (time) {
    try {
      const r = await ctx.chatwoot.atribuirTime({ tenantId: ctx.tenant.tenant_id, conversationId: ctx.conversationId, teamId: time.team_id });
      atribuiu = r.time ? { time: r.time } : 'nao_encontrado';
    } catch { atribuiu = 'falhou'; }
  }
  // onError: continue, como no n8n — mas o trace fica sabendo se a pausa entrou.
  let pausou = false;
  try { pausou = (await fnValor<string>(ctx.db, 'api_n8n_definir_status_conversa', [ctx.tenant.tenant_id, ctx.conversationId, 'pausado'])) === 'pausado'; } catch { pausou = false; }
  const n = config.notificacao ?? { canal: 'nenhum' };
  let notificou: 'waha' | 'chatwoot' | 'nenhum' | 'falhou' = 'nenhum';
  // canal `waha` com sessão = como sempre; `chatwoot` (ou waha sem sessão) =
  // pela inbox do agente, sem sessão por conta (17/09). Ver `mandarAoDono`.
  if ((n.canal === 'waha' || n.canal === 'chatwoot') && n.destino) {
    try {
      notificou = await mandarAoDono({ db: ctx.db, chatwoot: ctx.chatwoot, waha: ctx.waha },
        { tenantId: ctx.tenant.tenant_id, sessao: n.sessao || null, destino: n.destino, texto: `🔔 *Novo atendimento solicitado!*\n\n💬 *Assunto:* ${resumo}\n\nO cliente solicita atendimento humano.` });
    } catch { notificou = 'falhou'; }
  }
  const resultado = typeof atribuiu === 'object'
    ? `${TEXTO_TRANSFERIDO} A conversa foi encaminhada ao time "${atribuiu.time.nome}" — diga isso ao cliente.`
    : TEXTO_TRANSFERIDO;
  return { resultado, disponivel, notificou, pausou, atribuiu };
}

export function ferramentaTransferirHumano(ctx: ContextoTool): FerramentaDoModelo {
  return {
    nome: 'transferir_humano',
    descricao: DESCRICAO,
    parametros: {
      type: 'object',
      properties: {
        resumo: { type: 'string', description: 'Resumo claro do que foi conversado, para o atendente que vai assumir.' },
        time: { type: 'string', description: 'Opcional: nome do time de atendimento que deve receber a conversa, exatamente como listado no prompt. Omita se não houver times ou se não tiver certeza.' },
      },
      required: ['resumo'],
      additionalProperties: false,
    },
    executar: async (args) => {
      const r = await transferirHumano(ctx, String(args.resumo ?? ''), typeof args.time === 'string' ? args.time : null);
      return { texto: r.resultado, diagnostico: { disponivel: r.disponivel, pausou: r.pausou, notificou: r.notificou, atribuiu: r.atribuiu } };
    },
  };
}
