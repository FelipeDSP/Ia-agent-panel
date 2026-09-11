#!/usr/bin/env node
/**
 * Estima `S` — o custo em tokens dos schemas das ferramentas de um perfil — a
 * partir do tamanho do que o n8n manda ao modelo.
 *
 * ---------------------------------------------------------------------------
 * ISTO É ESTIMATIVA, E O MÉTODO ESTÁ ESCRITO PARA PODER SER CONTESTADO
 *
 * O `S = 622` do perfil de vendas foi MEDIDO em 11/08 pelo método das duas
 * equações (n8n/estima-tokens.js), com SETE ferramentas e as descrições
 * ANTIGAS. Desde então: entrou a foto (8), as descrições foram reescritas em
 * 09/09, e a fusão de 11/09 levou a 5. Nada disso foi medido — medir exige uma
 * execução real do perfil, que ainda não houve com o conjunto novo.
 *
 * O que dá para fazer sem execução é CALIBRAR o tamanho contra o número medido:
 *
 *   1. reconstruir os schemas das 7 ferramentas de 11/08 (o JSON está no git,
 *      commit 188159b) e somar os caracteres — `C7`;
 *   2. `r_schema = C7 / 622` é quantos caracteres de SCHEMA cabem num token,
 *      calibrado contra a única medição que existe. Não é o `r = 3,112` do
 *      texto em português: schema é JSON com chaves em inglês e pontuação, e
 *      tokeniza diferente;
 *   3. somar os caracteres dos schemas do conjunto NOVO — `C5` — e dividir por
 *      `r_schema`.
 *
 * Isso NÃO é regra de três por contagem de ferramentas ("622 ÷ 7 × 5"). A regra
 * de três ignora que as descrições novas são bem mais longas que as antigas —
 * ela daria ~444 e estaria errada para baixo. Esta estimativa acompanha o
 * tamanho real do texto. Continua sendo estimativa: a forma como o n8n
 * serializa o schema e como o tokenizador da OpenAI o parte não é reproduzida
 * aqui, só aproximada pela calibração.
 *
 * ---------------------------------------------------------------------------
 * O QUE ENTRA NO SCHEMA DE UMA `toolWorkflow`
 *
 * O modelo recebe, por ferramenta: `name`, `description` e um JSON Schema com
 * UMA propriedade por `$fromAI(nome, descrição, tipo)` das entradas. As
 * entradas que vêm do fluxo (tenant_id, conversation_id, account_id) NÃO vão
 * ao modelo. É isso que é medido aqui.
 *
 * Uso:
 *   node scripts/estimar-s.mjs                     (o JSON do repo)
 *   node scripts/estimar-s.mjs <arquivo.json>      (outro, ex.: extraído do git)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = fileURLToPath(new URL('../', import.meta.url));
const ARQ = process.argv[2] ?? path.join(RAIZ, 'n8n', 'workflows', 'agente-principal.json');
const w = JSON.parse(fs.readFileSync(ARQ, 'utf8'));

/** O schema que o modelo recebe para um nó toolWorkflow. */
function schemaDe(n) {
  const props = {};
  const valores = n.parameters?.workflowInputs?.value ?? {};
  for (const [campo, expr] of Object.entries(valores)) {
    const m = String(expr).match(/\$fromAI\('([^']+)',\s*`([^`]*)`,\s*'(\w+)'\)/);
    if (m) props[m[1]] = { type: m[3], description: m[2] };
  }
  // Ferramentas antigas (busca KB, transferir, resolver) usam outros formatos de
  // entrada; para elas o schema é o que o nó declarar em `schemaType`/`inputSchema`
  // ou nada além da description.
  return {
    name: n.name.replace(/[^A-Za-z0-9_]+/g, '_'),
    description: n.parameters?.description ?? '',
    parameters: { type: 'object', properties: props, required: Object.keys(props) },
  };
}

const tools = w.nodes.filter((n) => n.type === '@n8n/n8n-nodes-langchain.toolWorkflow');
let total = 0;
console.log(`${path.relative(RAIZ, ARQ) || ARQ}: ${tools.length} ferramenta(s)\n`);
for (const n of tools) {
  const s = JSON.stringify(schemaDe(n));
  total += s.length;
  console.log(`  ${n.name.padEnd(48)} ${String(s.length).padStart(6)} chars`);
}
console.log(`  ${'TOTAL'.padEnd(48)} ${String(total).padStart(6)} chars`);

// Perfis: quais ferramentas cada agent tem, pelas conexões `ai_tool`.
const porAgente = {};
for (const n of tools) {
  const ligs = w.connections?.[n.name]?.ai_tool?.flat() ?? [];
  for (const c of ligs) {
    porAgente[c.node] ??= [];
    porAgente[c.node].push(n);
  }
}
console.log('');
for (const [agente, ns] of Object.entries(porAgente)) {
  const c = ns.reduce((acc, n) => acc + JSON.stringify(schemaDe(n)).length, 0);
  console.log(`  ${agente.padEnd(20)} ${ns.length} tools  ${String(c).padStart(6)} chars`);
}

export { schemaDe };
