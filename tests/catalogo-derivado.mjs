/**
 * O catálogo de tools é DERIVADO do código: `REGISTRO_TOOLS` (src/lib/tools/
 * registro.ts) e `catalogo_tools` (banco) têm de descrever as MESMAS tools.
 *
 * Fonte ↔ derivado, nos dois sentidos:
 *   - tool no registry sem linha no banco: as funções `api_n8n_tools_ativas` /
 *     `api_n8n_config_tool` nunca a listam — o código a tem e nenhum tenant a
 *     recebe (o que aconteceu com `pagamento` até a 61 criar a linha);
 *   - linha no banco sem registry: aparece em Módulos, pode ser contratada e
 *     não faz nada (o que a tela "Criar tool" produzia até 16/09).
 *
 * E o tipo (tool do modelo × etapa do fluxo) tem de bater. Lista vazia
 * reprova antes de comparar (guarda que compara listas).
 *
 *   npm run teste:catalogo-derivado
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { REGISTRO_TOOLS } from '../src/lib/tools/registro.ts';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let ok = 0;
const falhas = [];
const chk = (nome, cond, det = '') => {
  if (cond) { ok++; console.log(`  OK    ${nome}`); }
  else { falhas.push(nome); console.log(`  FALHA ${nome}${det ? ` — ${det}` : ''}`); }
};
const url = process.env.SUPABASE_DB_URL ?? fs.readFileSync(path.join(RAIZ, '.env.local'), 'utf8')
  .split(/\r?\n/).find((l) => l.startsWith('SUPABASE_DB_URL='))?.slice('SUPABASE_DB_URL='.length).trim().replace(/^["']|["']$/g, '');
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await c.connect();
try {
  const banco = (await c.query(`select tool_nome, tipo, ativo from public.catalogo_tools order by tool_nome`)).rows;
  const codigo = Object.values(REGISTRO_TOOLS);
  chk('as duas listas são não-vazias (lista vazia reprova antes de comparar)', banco.length > 0 && codigo.length > 0, `${banco.length}/${codigo.length}`);
  const noBanco = new Set(banco.map((b) => b.tool_nome));
  const noCodigo = new Set(codigo.map((d) => d.nome));
  const soCodigo = [...noCodigo].filter((n) => !noBanco.has(n));
  const soBanco = [...noBanco].filter((n) => !noCodigo.has(n));
  chk('toda tool do código tem linha em catalogo_tools', soCodigo.length === 0, `faltam no banco: ${soCodigo.join(', ')}`);
  chk('toda linha de catalogo_tools existe no código', soBanco.length === 0, `sobram no banco: ${soBanco.join(', ')}`);
  const tiposDivergem = banco.filter((b) => noCodigo.has(b.tool_nome) && (REGISTRO_TOOLS[b.tool_nome].tipo ?? 'tool_modelo') !== b.tipo).map((b) => b.tool_nome);
  chk('o tipo (tool_modelo × capacidade_fluxo) bate nas duas', tiposDivergem.length === 0, tiposDivergem.join(', '));
  // Contraprova de que a comparação não é vácua: injetar uma tool só no código tem de acusar.
  const comFalsa = new Set([...noCodigo, 'tool_que_nao_existe']);
  chk('contraprova: uma tool inventada no código seria acusada', [...comFalsa].filter((n) => !noBanco.has(n)).length === 1);
  // A tela não pode mais criar/editar tool: só ocultar/mostrar.
  const acoes = fs.readFileSync(path.join(RAIZ, 'src/app/(app)/admin/acoes.ts'), 'utf8');
  const comp = fs.readFileSync(path.join(RAIZ, 'src/app/(app)/admin/catalogo/componentes.tsx'), 'utf8');
  chk('não existe mais ação de criar/editar tool pela tela', !/criarToolCatalogo|editarToolCatalogo/.test(acoes) && !/workflow_id_padrao|descricao_padrao/.test(comp));
  chk('a única escrita do catálogo é `ativo`, e só para tool que o código conhece', /update\(\{ ativo \}\)/.test(acoes) && /!REGISTRO_TOOLS\[tool_nome\]/.test(acoes));
} finally {
  await c.end();
}
console.log(`\n${ok} passaram, ${falhas.length} falharam\n`);
if (falhas.length) process.exit(1);
