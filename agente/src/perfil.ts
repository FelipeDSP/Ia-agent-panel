/**
 * `Tools Ativas` + `Vende?`: o perfil do tenant é `vendas` se a tool `vendas`
 * está ativa (contratada E ligada), senão `basico`. A mesma consulta do n8n
 * (`api_n8n_tools_ativas`), e a mesma decisão.
 */
import { fnTodas, type Db } from './db.ts';
import type { Perfil } from './agente/prompt.ts';

export async function resolverPerfil(db: Db, tenantId: string): Promise<{ perfil: Perfil; toolsAtivas: string[] }> {
  const linhas = await fnTodas<{ tool_nome: string }>(db, 'api_n8n_tools_ativas', [tenantId]);
  const toolsAtivas = linhas.map((l) => l.tool_nome);
  return { perfil: toolsAtivas.includes('vendas') ? 'vendas' : 'basico', toolsAtivas };
}
