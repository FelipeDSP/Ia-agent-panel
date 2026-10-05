// Os módulos .mjs de `agente/regras/` que o serviço importa direto.
// Nasceram como nós Code do n8n; desde 05/10 moram aqui e a pasta n8n/ não existe mais.
declare module '*/regras/tool-pedido-acoes.mjs' {
  export const TOOL_NOME: string;
  export const ACOES: Array<{ acao: string; funcao: string; query: string; params: string[]; descricao: string; prompt: string; notificaVenda?: boolean }>;
  export const NOMES_ACOES: string[];
  export function descricaoFerramenta(): string;
  export function secaoPrompt(): string;
  export function textoAcaoInvalida(): string;
  export function dicaFromAI(): string;
}
declare module '*/regras/tool-pagamento-fonte.mjs' {
  export const TOOL_NOME: string;
  export const DUE_DATE_LIMIT_DAYS: number;
  export const POLITICA_EXPIRACAO: string | null;
  export const ENCERRAMENTO: Record<string, unknown>;
  export function descricaoFerramenta(): string;
  export function secaoPrompt(): string;
}
