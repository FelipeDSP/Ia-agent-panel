/**
 * O que toda ferramenta recebe do TURNO — e o modelo não controla nada disto.
 * `tenant_id`, `conversation_id` e `account_id` vêm do fluxo (a regra do
 * README do n8n); o schema que o modelo vê tem só os argumentos de negócio.
 */
import type { Db } from '../db.ts';
import type { Chatwoot } from '../chatwoot/enviar.ts';
import type { Waha } from '../waha/notificar.ts';
import type { Tenant } from '../tenant/resolver.ts';
import type { Asaas } from '../pagamento/asaas.ts';

export interface Embeddings {
  /** text-embedding-3-small, 1536 dimensões, fixo (CLAUDE.md). */
  gerar(texto: string): Promise<number[]>;
}

export interface ContextoTool {
  db: Db;
  tenant: Tenant;
  conversationId: number;
  accountId: number | null;
  chatwoot: Chatwoot;
  waha: Waha | null;
  embeddings: Embeddings | null;
  n8nJsDir: string;
  /** O `x-foto-secret` da Edge Function `foto-produto` (env FOTO_SECRET); sem ele a foto não assina. */
  fotoSecret: string | null;
  /** `fetch` injetável (testes). */
  fetchFn: typeof fetch;
  /** O Asaas (pagamento por link); `null` desliga a tool mesmo que contratada. */
  asaas: Asaas | null;
  /** `tenants.pagamento_formas` (66): subconjunto de PIX / CREDIT_CARD / BOLETO. */
  pagamentoFormas?: string[];
}

/** `api_n8n_config_tool(tenant, tool)` — a primeira coisa de toda tool, como no n8n. */
export interface ConfigTool { chatwoot_url: string | null; chatwoot_token: string | null; tool_ativa: boolean; config: Record<string, unknown> | null }
