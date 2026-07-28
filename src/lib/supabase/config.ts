/**
 * Leitura das variaveis de ambiente do Supabase, num lugar so.
 *
 * As duas chaves publicas ficam neste arquivo. A chave secreta NAO — ela mora
 * em `admin.ts`, que tem `import 'server-only'` no topo. Manter as duas
 * separadas e o que faz o bundler quebrar o build se alguem importar a secreta
 * de um componente client, em vez de embutir a chave no JavaScript do browser.
 */

function obrigatoria(nome: string, valor: string | undefined): string {
  if (!valor) {
    throw new Error(
      `Variavel de ambiente ausente: ${nome}. ` +
        `Copie .env.local.exemplo para .env.local e preencha.`,
    );
  }
  return valor;
}

export const SUPABASE_URL = obrigatoria(
  'NEXT_PUBLIC_SUPABASE_URL',
  process.env.NEXT_PUBLIC_SUPABASE_URL,
);

export const SUPABASE_PUBLISHABLE_KEY = obrigatoria(
  'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
);
