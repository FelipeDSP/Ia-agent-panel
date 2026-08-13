/**
 * Resolve import relativo sem extensão para `.ts`.
 *
 * POR QUE EXISTE. O Node 24 já executa TypeScript direto (type stripping), mas
 * não resolve `./tipos` para `./tipos.ts` — ESM exige extensão, e o código do
 * app usa a convenção do TS/Next, sem ela. Sem este hook, `import('registro.ts')`
 * morre em "Cannot find module .../transferir-humano".
 *
 * O QUE ISTO COMPRA. O teste importa a FONTE, não uma cópia da lógica. Um teste
 * que reimplementa a regra que ele testa concorda consigo mesmo para sempre — e
 * este projeto já pagou por asserção que não conseguia falhar.
 *
 * Só age no fallback: tenta o especificador original primeiro e só acrescenta a
 * extensão quando ele não resolve. Nada que já funciona muda de caminho.
 */

export async function resolve(especificador, contexto, proximo) {
  try {
    return await proximo(especificador, contexto);
  } catch (erro) {
    if (!especificador.startsWith('.')) throw erro;
    for (const sufixo of ['.ts', '/index.ts', '.tsx']) {
      try {
        return await proximo(especificador + sufixo, contexto);
      } catch {
        // tenta o próximo sufixo
      }
    }
    throw erro;
  }
}
