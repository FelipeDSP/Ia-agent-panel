/**
 * TOOL gerar_link_pagamento — o porte do sub-workflow `Tool - Gerar Link de
 * Pagamento (Multi-Tenant)` que o n8n nunca chegou a importar (congelado).
 *
 *   Reserva Cobranca  api_n8n_gerar_cobranca(t, conv)  -> ok? ja_existia? valor, credencial
 *   Cria Link Asaas   POST /v3/paymentLinks              (só quando ok e não reuso)
 *   Registra Cobranca api_n8n_registrar_cobranca(t, cobranca_id, ok, link_id, url | detalhe)
 *   Monta Resposta    n8n/tool-pagamento-resposta.js    (o MESMO corpo; o texto é escrito lá)
 *
 * O que o modelo NÃO controla (docs/ENTREGA-PAGAMENTO-ASAAS-SANDBOX.md §11.2):
 * zero propriedades no schema; o valor sai de `pedidos.total_centavos` dentro
 * da função; a chave é a do tenant, na linha da reserva. A conversão centavos
 * -> decimal acontece UMA vez, aqui, na fronteira com o Asaas. O Asaas fora do
 * ar não derruba o turno: registra `falhou_em` e o modelo recebe "NÃO invente
 * um link".
 */
import { fnUma, fnValor } from '../db.ts';
import { corpoN8n, rodarN8n } from '../n8n-js.ts';
import type { FerramentaDoModelo } from '../agente/modelo.ts';
import type { ContextoTool } from './contexto.ts';
import type { Asaas } from '../pagamento/asaas.ts';
import { DUE_DATE_LIMIT_DAYS, descricaoFerramenta } from '../../../n8n/tool-pagamento-fonte.mjs';

export const NOME_FERRAMENTA = 'gerar_link_pagamento';

export interface Reserva {
  ok: boolean; motivo: string | null; cobranca_id: string | null; ja_existia: boolean;
  pedido_id: string | null; pedido_numero: number | null; valor_centavos: number | null;
  minimo_centavos: number | null; faltam_centavos: number | null; expira_em: Date | string | null;
  vence_em: Date | string | null; descricao: string | null; referencia_externa: string | null;
  url: string | null; ambiente: string | null; base_url: string | null; api_key: string | null;
}

export interface ResultadoLink { texto: string; diagnostico: Record<string, unknown> }

/**
 * `tenants.pagamento_formas` -> `billingType` do link: uma forma vai ela; mais de
 * uma vira `UNDEFINED` (o cliente escolhe entre o que a CONTA tem habilitado —
 * é o que o Asaas oferece; não há como restringir a um subconjunto). Vazio ou
 * inválido cai em PIX, o comportamento de antes da 66.
 */
export function billingTypeDe(formas: string[] | undefined): 'PIX' | 'CREDIT_CARD' | 'BOLETO' | 'UNDEFINED' {
  const validas = (formas ?? []).filter((f): f is 'PIX' | 'CREDIT_CARD' | 'BOLETO' => f === 'PIX' || f === 'CREDIT_CARD' || f === 'BOLETO');
  if (validas.length === 0) return 'PIX';
  return validas.length === 1 ? validas[0]! : 'UNDEFINED';
}

/** O corpo que vai ao Asaas — o do nó `Cria Link Asaas`, verbatim (só o `billingType` passou a ser do tenant). */
export function corpoDoLink(r: Reserva, formas?: string[]): Record<string, unknown> {
  const vence = r.vence_em instanceof Date ? r.vence_em.toISOString() : String(r.vence_em ?? '');
  return {
    name: r.descricao,
    description: 'Pedido nº ' + r.pedido_numero,
    billingType: billingTypeDe(formas),
    chargeType: 'DETACHED',
    value: Math.round(Number(r.valor_centavos)) / 100,
    endDate: vence.slice(0, 10),
    dueDateLimitDays: DUE_DATE_LIMIT_DAYS,
    externalReference: r.referencia_externa,
    notificationEnabled: false,
  };
}

export async function gerarLinkPagamento(ctx: ContextoTool, asaas: Asaas): Promise<ResultadoLink> {
  const corpo = corpoN8n(ctx.n8nJsDir, 'tool-pagamento-resposta.js');
  const montar = (entrada: Record<string, unknown>) => String(rodarN8n(corpo, { json: entrada }).resultado ?? '');

  const reserva = await fnUma<Reserva>(ctx.db, 'api_n8n_gerar_cobranca', [ctx.tenant.tenant_id, ctx.conversationId]);
  if (!reserva) return { texto: montar({ reserva: { ok: false, motivo: 'sem_resposta' } }), diagnostico: { motivo: 'sem_resposta' } };
  // A chave NUNCA sai daqui: o que vai ao script de resposta e ao trace é a reserva SEM ela.
  const { api_key, ...reservaSemChave } = reserva;
  const diagnostico: Record<string, unknown> = { ok: reserva.ok, motivo: reserva.motivo, cobranca_id: reserva.cobranca_id, ja_existia: reserva.ja_existia, pedido_numero: reserva.pedido_numero, valor_centavos: reserva.valor_centavos, ambiente: reserva.ambiente };

  if (!reserva.ok || reserva.ja_existia) return { texto: montar({ reserva: reservaSemChave }), diagnostico };

  let resp: { ok: boolean; status: number; corpo: Record<string, unknown> | null; detalhe: string };
  try {
    resp = await asaas.criarLink(String(reserva.base_url), String(api_key), corpoDoLink(reserva, ctx.pagamentoFormas));
  } catch (e) {
    resp = { ok: false, status: 0, corpo: null, detalhe: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
  }
  const id = resp.corpo?.id != null ? String(resp.corpo.id) : '';
  const url = resp.corpo?.url != null ? String(resp.corpo.url) : '';
  diagnostico.asaas_status = resp.status;

  if (resp.ok && id && url) {
    await fnValor(ctx.db, 'api_n8n_registrar_cobranca', [ctx.tenant.tenant_id, reserva.cobranca_id, true, id, url, null]);
    diagnostico.link_id = id;
    return { texto: montar({ reserva: reservaSemChave, asaas: { id, url } }), diagnostico };
  }
  await fnValor(ctx.db, 'api_n8n_registrar_cobranca', [ctx.tenant.tenant_id, reserva.cobranca_id, false, null, null, resp.detalhe.slice(0, 500)]);
  diagnostico.falha = resp.detalhe;
  return { texto: montar({ reserva: reservaSemChave, falha_http: resp.detalhe }), diagnostico };
}

export function ferramentaGerarLinkPagamento(ctx: ContextoTool, asaas: Asaas): FerramentaDoModelo {
  return {
    nome: NOME_FERRAMENTA,
    descricao: descricaoFerramenta(),
    // ZERO propriedades: não há parâmetro que o modelo possa envenenar porque não há parâmetro.
    parametros: { type: 'object', properties: {}, required: [], additionalProperties: false },
    executar: async () => gerarLinkPagamento(ctx, asaas),
  };
}
