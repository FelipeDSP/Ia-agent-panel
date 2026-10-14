import { createHash } from 'node:crypto';

/**
 * O hash do prompt em que uma proposta se baseou — SÓ no servidor.
 *
 * MORA SEPARADO DE `proposta.ts` POR UM MOTIVO MECÂNICO, não de organização:
 * `conversa.tsx` é componente de cliente e importa `TIPOS` e os tipos de
 * `proposta.ts`. Um componente de cliente arrasta o grafo INTEIRO de imports
 * para o bundle do navegador, então o `node:crypto` que estava lá dentro
 * derrubou o build:
 *
 *     Module build failed: UnhandledSchemeError: Reading from "node:crypto"
 *     ./src/lib/assistente/proposta.ts
 *     ./src/app/(app)/painel/assistente/conversa.tsx
 *
 * Um módulo "puro" com um único import de `node:` deixa de ser importável pelo
 * cliente, e quem paga é a tela — em tempo de build, que é a hora boa.
 *
 * Sem `server-only` aqui de propósito: os testes importam esta função
 * diretamente, e o que impede o uso no cliente é não haver cliente que a
 * importe. Quem faz valer é o build, que acabou de provar que faz.
 */
export function hashPrompt(texto: string): string {
  return createHash('sha256').update(String(texto ?? ''), 'utf8').digest('hex').slice(0, 16);
}
