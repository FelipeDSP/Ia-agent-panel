/**
 * Para ONDE o botão "Limpar memória" manda o pedido — decidido por
 * `tenants.agente_runtime` (migração 62), não por configuração global.
 *
 * Durante a migração do agente para código (DESENHO-AGENTE-EM-CODIGO.md §7)
 * os dois lados coexistem: tenant em `n8n` tem a memória no Redis e só o
 * webhook do n8n a alcança; tenant em `codigo` tem a memória em
 * `mensagens_log` e o corte é feito pelo serviço (`POST /limpar-memoria`,
 * mesmo contrato). Mandar para o lado errado não dá erro — o n8n apaga
 * chaves que não existem e responde 200, e o cliente acha que limpou.
 *
 * Puro (sem `server-only`) para o teste importar. Os SEGREDOS continuam
 * server-side: quem chama é a Server Action, que passa `process.env`.
 */
export type RuntimeDoAgente = 'n8n' | 'codigo';

export type DestinoLimpeza =
  | { ok: true; runtime: RuntimeDoAgente; url: string; segredo: string; nome: string }
  | { ok: false; motivo: string };

const VARIAVEIS: Record<RuntimeDoAgente, { url: string; segredo: string; nome: string }> = {
  n8n: { url: 'N8N_LIMPEZA_URL', segredo: 'N8N_LIMPEZA_SECRET', nome: 'n8n' },
  codigo: { url: 'AGENTE_LIMPEZA_URL', segredo: 'AGENTE_LIMPEZA_SECRET', nome: 'agente' },
};

/** `null`/desconhecido cai em `n8n`: é o default da coluna e o lado que atende quem nunca foi apontado. */
export function normalizarRuntime(valor: unknown): RuntimeDoAgente {
  return valor === 'codigo' ? 'codigo' : 'n8n';
}

export function resolverDestinoLimpeza(
  runtimeBruto: unknown,
  env: Record<string, string | undefined>,
): DestinoLimpeza {
  const runtime = normalizarRuntime(runtimeBruto);
  const v = VARIAVEIS[runtime];
  const url = env[v.url]?.trim();
  const segredo = env[v.segredo]?.trim();
  if (!url || !segredo) {
    return {
      ok: false,
      motivo:
        `Limpeza de memória não configurada para o agente em ${v.nome}. ` +
        `Defina ${v.url} e ${v.segredo} no ambiente do painel.`,
    };
  }
  return { ok: true, runtime, url, segredo, nome: v.nome };
}
