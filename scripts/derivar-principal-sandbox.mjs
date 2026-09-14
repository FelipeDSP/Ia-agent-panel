#!/usr/bin/env node
/**
 * Deriva `n8n/workflows/agente-principal.sandbox.json` de `agente-principal.json`.
 *
 * ---------------------------------------------------------------------------
 * POR QUE EXISTE
 *
 * A conta 57 (`estudyou-sendbox`) é atendida por uma CÓPIA do principal
 * (`eIRQNUl6xO7TarBv`, path `/Hercules-teste`), e é nela que o experimento da
 * fusão entra — `emporio` e `ceejaar` seguem no principal, intocados. Mas o
 * gerador NÃO seta o path do webhook (é campo órfão do JSON), então importar
 * `agente-principal.json` por cima da cópia trocaria o path para o do
 * principal, e o n8n RECUSA ativar dois workflows no mesmo path: a cópia
 * ficaria inativa e o sendbox mudo, sem ninguém ver.
 *
 * Este script produz o JSON que JÁ VEM com o path certo. É DERIVAÇÃO, não
 * cópia editada: a variante difere do principal exatamente em dois campos
 * (`Webhook.parameters.path` e `name`), e `teste:principal-sandbox` reprova se
 * o arquivo gravado não for byte a byte o que esta função devolve — se o
 * principal mudar e ninguém regerar, a suíte acusa.
 *
 * Uso: node scripts/derivar-principal-sandbox.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = fileURLToPath(new URL('../', import.meta.url));
export const ORIGEM = path.join(RAIZ, 'n8n', 'workflows', 'agente-principal.json');
export const DESTINO = path.join(RAIZ, 'n8n', 'workflows', 'agente-principal.sandbox.json');

/** O path que o bot Hércules (conta 57) chama. Conferido na instância em 14/09/2026. */
export const PATH_SANDBOX = 'Hercules-teste';
export const SUFIXO_NOME = ' — SANDBOX (copia)';

/** Pura: recebe o principal parseado, devolve a variante. */
export function derivar(principal) {
  const w = JSON.parse(JSON.stringify(principal));
  const webhooks = w.nodes.filter((n) => n.type === 'n8n-nodes-base.webhook');
  if (webhooks.length !== 1) throw new Error(`esperava 1 nó webhook no principal, achei ${webhooks.length}`);
  webhooks[0].parameters.path = PATH_SANDBOX;
  w.name = principal.name + SUFIXO_NOME;
  return w;
}

export function serializar(w) {
  return JSON.stringify(w, null, 2) + '\n';
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const principal = JSON.parse(fs.readFileSync(ORIGEM, 'utf8'));
  const variante = derivar(principal);
  fs.writeFileSync(DESTINO, serializar(variante));
  console.log(`escrito: ${path.relative(RAIZ, DESTINO)} (path /${PATH_SANDBOX}, name "${variante.name}")`);
  console.log('IMPORTAR É PASSO HUMANO — por cima da cópia eIRQNUl6xO7TarBv, nunca do principal.');
}
