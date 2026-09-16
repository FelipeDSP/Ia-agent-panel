// Os módulos .mjs do n8n/ que o serviço importa direto (fonte única na transição).
declare module '*/n8n/tool-pedido-acoes.mjs' {
  export const TOOL_NOME: string;
  export const ACOES: Array<{ acao: string; funcao: string; query: string; params: string[]; descricao: string; prompt: string; notificaVenda?: boolean }>;
  export const NOMES_ACOES: string[];
  export function descricaoFerramenta(): string;
  export function secaoPrompt(): string;
  export function textoAcaoInvalida(): string;
  export function dicaFromAI(): string;
}
declare module '*/n8n/tool-pagamento-fonte.mjs' {
  export const TOOL_NOME: string;
  export const DUE_DATE_LIMIT_DAYS: number;
  export const POLITICA_EXPIRACAO: string | null;
  export const ENCERRAMENTO: Record<string, unknown>;
  export function descricaoFerramenta(): string;
  export function secaoPrompt(): string;
}
