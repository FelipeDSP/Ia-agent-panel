/**
 * `Resolve Tenant` + `Tenant Valido?` + o runtime.
 *
 * O par (conta, caixa) resolve o tenant pela MESMA função do n8n
 * (`api_n8n_tenant_por_chatwoot`, migração 54): caixa nula estoura 22023 de
 * propósito, e isto NÃO é tratado com valor de reserva.
 *
 * E há um portão a mais, que o n8n não tem: `agente_runtime`. Se o tenant
 * está em 'n8n', o serviço NÃO atende — respondeu 200 e descarta. É o que
 * impede duas respostas para a mesma mensagem enquanto uma caixa está sendo
 * apontada, e é o que faz o serviço poder estar no ar, com a 62 aplicada,
 * sem atender ninguém até que alguém troque a URL de um bot.
 */
import { fnUma, fnValor, type Db } from '../db.ts';

export interface Tenant {
  tenant_id: string;
  slug: string;
  nome: string;
  agente_ativo: boolean;
  system_prompt: string | null;
  modelo: string | null;
  temperatura: number | null;
  debounce_segundos: number;
  msg_midia_nao_suportada: string | null;
  msg_fora_escopo: string | null;
  chatwoot_url: string | null;
}

export type Resolucao =
  | { ok: true; tenant: Tenant; runtime: 'codigo' }
  | { ok: false; motivo: 'caixa_nula' | 'tenant_desconhecido' | 'runtime_n8n' | 'agente_inativo'; tenant?: Tenant; erro?: string };

export async function resolverTenant(db: Db, accountId: number | null, inboxId: number | null): Promise<Resolucao> {
  if (inboxId === null || inboxId === undefined) return { ok: false, motivo: 'caixa_nula' };
  let linha: Tenant | undefined;
  try {
    linha = await fnUma<Tenant>(db, 'api_n8n_tenant_por_chatwoot', [accountId, inboxId]);
  } catch (e) {
    // 22023 é a função recusando caixa nula; qualquer outro erro sobe.
    if ((e as { code?: string }).code === '22023') return { ok: false, motivo: 'caixa_nula', erro: (e as Error).message };
    throw e;
  }
  if (!linha) return { ok: false, motivo: 'tenant_desconhecido' };
  const runtime = await fnValor<string | null>(db, 'api_agente_runtime', [linha.tenant_id]);
  if (runtime !== 'codigo') return { ok: false, motivo: 'runtime_n8n', tenant: linha };
  if (!linha.agente_ativo) return { ok: false, motivo: 'agente_inativo', tenant: linha };
  return { ok: true, tenant: linha, runtime: 'codigo' };
}
