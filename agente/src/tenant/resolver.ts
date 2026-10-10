/**
 * `Resolve Tenant` + `Tenant Valido?` + o runtime.
 *
 * A CONTA resolve o tenant (`api_agente_tenant_por_conta`, migração 86).
 * Conta nula estoura 22023 de propósito, e isto NÃO é tratado com valor de
 * reserva — seria o serviço escolhendo um tenant qualquer para uma mensagem
 * sem dono.
 *
 * ERA O PAR (conta, caixa), pela 54, e isso estava errado (10/10). O robô da
 * Acqua está em DUAS caixas da conta 56; mensagem vinda da segunda não casava
 * linha nenhuma, e o serviço respondia 200 e descartava como "não é meu
 * tenant". O cliente escrevia e não recebia nada, sem erro em lugar nenhum.
 *
 * Quem decide em quais caixas o robô atende é o CHATWOOT, quando alguém anexa
 * o Agent Bot à caixa — só chega webhook de caixa onde ele está aplicado.
 * Nosso filtro de caixa duplicava essa decisão e, duplicando, discordava dela.
 *
 * A caixa continua decidindo no casamento ESTRITO (uma conta pode ter dois
 * agentes, um por caixa — migração 54). O que mudou é que, quando ela não casa
 * e a conta tem um dono só, a conta resolve sozinha. Ver a 87.
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
  | { ok: false; motivo: 'conta_nula' | 'tenant_desconhecido' | 'runtime_n8n' | 'agente_inativo'; tenant?: Tenant; erro?: string };

/**
 * A caixa VOLTOU a importar — mas só para o casamento estrito (87).
 *
 * A 86 tinha tirado a caixa da resolução de vez, e com ela a capacidade da 54
 * de ter dois agentes na mesma conta. A 87 faz as duas coisas: casa estrito por
 * (conta, caixa) e, se não achar, cai para a conta quando ela tem um dono só.
 * Por isso os dois valores seguem indo à função.
 */
export async function resolverTenant(db: Db, accountId: number | null, inboxId: number | null): Promise<Resolucao> {
  if (accountId === null || accountId === undefined) return { ok: false, motivo: 'conta_nula' };
  let linha: Tenant | undefined;
  try {
    linha = await fnUma<Tenant>(db, 'api_agente_tenant_por_conta', [accountId, inboxId]);
  } catch (e) {
    // 22023 é a função recusando conta nula; qualquer outro erro sobe.
    if ((e as { code?: string }).code === '22023') return { ok: false, motivo: 'conta_nula', erro: (e as Error).message };
    throw e;
  }
  if (!linha) return { ok: false, motivo: 'tenant_desconhecido' };
  const runtime = await fnValor<string | null>(db, 'api_agente_runtime', [linha.tenant_id]);
  if (runtime !== 'codigo') return { ok: false, motivo: 'runtime_n8n', tenant: linha };
  if (!linha.agente_ativo) return { ok: false, motivo: 'agente_inativo', tenant: linha };
  return { ok: true, tenant: linha, runtime: 'codigo' };
}
