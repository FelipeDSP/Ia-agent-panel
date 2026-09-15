/**
 * Log do processo: uma linha JSON por evento, em stdout (o Coolify guarda).
 * Nunca imprime texto de cliente, token ou chave — o que é de tenant vai
 * para o trace no banco, com RLS, não para o log do container.
 */
export type Nivel = 'info' | 'aviso' | 'erro';

export function log(nivel: Nivel, evento: string, campos: Record<string, unknown> = {}): void {
  const linha = { t: new Date().toISOString(), nivel, evento, ...campos };
  const texto = JSON.stringify(linha);
  if (nivel === 'erro') process.stderr.write(texto + '\n');
  else process.stdout.write(texto + '\n');
}

export function erroTexto(e: unknown): string {
  if (e instanceof AggregateError) {
    const primeiro = e.errors[0];
    return `${e.name}: ${e.message || (primeiro instanceof Error ? primeiro.message : String(primeiro))}`;
  }
  if (e instanceof Error) {
    const code = (e as { code?: string }).code;
    return `${e.name}${code ? ` [${code}]` : ''}: ${e.message}`;
  }
  return String(e);
}
