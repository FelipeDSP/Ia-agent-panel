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

/*
 * `server-only` VIRA MÓDULO VAZIO no teste.
 *
 * O pacote existe para explodir quando um módulo de servidor é puxado para o
 * bundle do cliente — e a checagem dele é feita pelo campo `exports` do
 * package.json, que fora do Next resolve para a versão que sempre lança. Sob
 * `node`, importar QUALQUER arquivo marcado `server-only` mata o teste.
 *
 * Neutralizar aqui não afrouxa nada em produção: quem faz valer a regra é o
 * empacotamento do Next, que continua reprovando o import indevido — e o
 * `npm run build` roda em toda entrega. O que se ganha é poder testar a lógica
 * que mora nesses arquivos, que é justamente onde vive o que fala com serviço
 * externo.
 */
export async function resolve(especificador, contexto, proximo) {
  if (especificador === 'server-only') {
    return { url: 'data:text/javascript,export{}', shortCircuit: true };
  }
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
