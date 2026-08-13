/**
 * Superfície de tool: a propriedade permanente e as três verificações.
 *
 * A PROPRIEDADE, escrita como propriedade e não como lista das tools de hoje:
 *
 *   Toda superfície que uma tool traz — item de menu, rota, seção de tela,
 *   indicador, Server Action — só existe para quem contratou aquela tool.
 *
 * Lista envelhece na próxima tool; propriedade não. É por isso que nada aqui
 * cita "vendas" como se fosse o caso especial: o que se afirma vale para
 * qualquer entrada do registry, inclusive as que ainda não existem.
 *
 * POR QUE TRÊS VERIFICAÇÕES, e não uma. Elas pegam coisas diferentes:
 *
 *  1. MENU A PARTIR DO REGISTRY (mecanismo, não teste) — esquecer de declarar
 *     `rotasPainel` faz o item não aparecer para NINGUÉM. Ausência alguém nota;
 *     vazamento silencioso ninguém nota. O teste aqui só confere o resultado.
 *
 *  2. ROTA DECLARADA — o mecanismo fica quieto no caso do dev que cria
 *     `/painel/agenda/page.tsx` e não encosta no menu: não há item para faltar.
 *     Esta seção varre o disco e exige que toda rota sob /painel/ pertença a
 *     alguma tool ou esteja em ROTAS_SEMPRE_VISIVEIS.
 *
 *  3. ACTION GUARDADA — Server Action é entrada própria. Esconder menu e recusar
 *     rota não cobrem uma chamada RPC direta. Mesma classe do `alternarModulo`.
 *
 * O motivo de existirem: há três casos nesta semana de regra correta que não era
 * checada — `tool_ativa` nunca lido, `config_tool` ignorando `contratado`, e o
 * Resolver Conversa sem guarda. Regra em doc não sobrevive a seis meses.
 *
 * Uso: npm run teste:superficie
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  REGISTRO_TOOLS,
  ROTAS_SEMPRE_VISIVEIS,
  menuDoPainel,
  rotasDeTools,
  toolDaRota,
} from '../src/lib/tools/registro.ts';

const RAIZ = fileURLToPath(new URL('../', import.meta.url));
const DIR_PAINEL = path.join(RAIZ, 'src', 'app', '(app)', 'painel');

let passou = 0;
let falhou = 0;

function ok(condicao, descricao) {
  if (condicao) {
    passou++;
    console.log(`  OK    ${descricao}`);
  } else {
    falhou++;
    console.log(`  FALHA ${descricao}`);
  }
}

function eq(recebido, esperado, descricao) {
  ok(recebido === esperado, `${descricao} (esperado ${esperado}, veio ${recebido})`);
}

/** Caminha o diretório e devolve os arquivos que casam. */
function varrer(dir, casa, achados = []) {
  for (const nome of readdirSync(dir)) {
    const p = path.join(dir, nome);
    if (statSync(p).isDirectory()) varrer(p, casa, achados);
    else if (casa(nome)) achados.push(p);
  }
  return achados;
}

/** `.../painel/pedidos/[id]/page.tsx` -> `/painel/pedidos/[id]` */
function rotaDoArquivo(arquivo) {
  const rel = path.relative(DIR_PAINEL, path.dirname(arquivo)).split(path.sep).join('/');
  return rel === '' ? '/painel' : `/painel/${rel}`;
}

console.log('\n=== 1. Toda rota do painel tem dono declarado ===\n');

const sempre = new Set(ROTAS_SEMPRE_VISIVEIS.map((r) => r.href));
const rotasNoDisco = varrer(DIR_PAINEL, (n) => n === 'page.tsx').map(rotaDoArquivo);

ok(rotasNoDisco.length > 0, `varredura achou rotas (${rotasNoDisco.length})`);

// `/painel` é o índice e está em ROTAS_SEMPRE_VISIVEIS — mas herdar dele por
// prefixo tornaria TODA rota sob /painel/ automaticamente sempre-visível, e a
// checagem inteira vira decoração. Foi o que a primeira sabotagem mostrou:
// criei /painel/agenda sem declarar nada e o teste passou, com uma asserção
// verde a mais. Herança de prefixo vale para as outras, não para a raiz.
const PAIS_SEMPRE = [...sempre].filter((s) => s !== '/painel');

for (const rota of rotasNoDisco.sort()) {
  // Sub-rota (`/painel/pedidos/[id]`) herda a dona por prefixo. Para as
  // sempre-visíveis, o mesmo: `/painel/conversas/[id]` segue sempre-visível.
  const dona = toolDaRota(rota);
  const ehSempre = sempre.has(rota) || PAIS_SEMPRE.some((s) => rota.startsWith(`${s}/`));
  ok(
    dona !== null || ehSempre,
    `${rota}: declarada por tool (${dona ?? '—'}) ou sempre-visível (${ehSempre})`,
  );
}

// O outro lado: rota declarada no registry que não existe no disco é declaração
// morta — o item apareceria no menu e daria 404.
console.log('');
for (const { href, tool } of rotasDeTools()) {
  ok(
    rotasNoDisco.some((r) => r === href || r.startsWith(`${href}/`)),
    `${href} (declarada por ${tool}) existe no disco`,
  );
}

console.log('\n=== 2. Toda Server Action de superfície de tool é guardada ===\n');

// Arquivos 'use server' que vivem sob uma rota de tool. A regra: cada função
// exportada precisa de uma checagem de contratação. Contamos as duas — se
// alguém adicionar uma action e esquecer o guard, a contagem denuncia.
const arquivosServer = varrer(DIR_PAINEL, (n) => n.endsWith('.ts')).filter((p) =>
  readFileSync(p, 'utf8').startsWith("'use server'"),
);

const deTool = arquivosServer.filter((p) => toolDaRota(rotaDoArquivo(p)) !== null);
ok(deTool.length > 0, `há arquivo 'use server' sob rota de tool (${deTool.length})`);

for (const arquivo of deTool) {
  const fonte = readFileSync(arquivo, 'utf8');
  const rel = path.relative(RAIZ, arquivo).split(path.sep).join('/');

  // Comentários fora antes de contar — já houve neste projeto um regex casando
  // com o comentário em vez do código.
  const codigo = fonte
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  const actions = (codigo.match(/export async function/g) ?? []).length;
  const guards = (codigo.match(/temToolContratada\(/g) ?? []).length;

  ok(
    guards >= actions && actions > 0,
    `${rel}: ${actions} action(s), ${guards} checagem(ns) de contratação`,
  );
}

console.log('\n=== 3. O menu sai do registry, não de lista fixa ===\n');

const TODAS = new Set(Object.keys(REGISTRO_TOOLS));
const NENHUMA = new Set();

const menuCompleto = menuDoPainel(TODAS);
const menuVazio = menuDoPainel(NENHUMA);

// Sempre-visível aparece nos dois — é o que a decisão de falha garante.
for (const r of ROTAS_SEMPRE_VISIVEIS) {
  ok(
    menuVazio.some((i) => i.href === r.href),
    `${r.href}: sempre-visível aparece mesmo sem nenhuma tool contratada`,
  );
}

// Condicional só aparece com a tool contratada. Percorre o registry inteiro em
// vez de citar vendas: a asserção continua valendo para a próxima tool com tela.
for (const [nome, def] of Object.entries(REGISTRO_TOOLS)) {
  for (const r of def.rotasPainel ?? []) {
    ok(
      menuCompleto.some((i) => i.href === r.href),
      `${r.href}: aparece quando ${nome} está contratada`,
    );
    ok(
      !menuVazio.some((i) => i.href === r.href),
      `${r.href}: some quando ${nome} NÃO está contratada`,
    );
  }
}

console.log('\n=== 4. Falha na resolução: sempre-visíveis ficam, condicionais somem ===\n');

// A DECISÃO, escrita e não descoberta na primeira falha. `toolsContratadas`
// devolve conjunto vazio quando a query erra, e conjunto vazio é exatamente o
// caso testado acima. Aqui a afirmação é sobre a FORMA do resultado: nunca
// vazio de tudo (o cliente perderia até Configurações), nunca com condicional.
eq(menuVazio.length, ROTAS_SEMPRE_VISIVEIS.length, 'menu degradado = só as sempre-visíveis');
ok(
  menuVazio.every((i) => sempre.has(i.href)),
  'nenhum item condicional sobrevive à falha de resolução',
);
ok(
  menuVazio.some((i) => i.href === '/painel/configuracoes'),
  'Configurações sobrevive — sem ela o cliente não tem para onde ir',
);

console.log('\n=== 5. Ícone declarado existe no mapa do sidebar ===\n');

// O registry declara ícone por NOME (é módulo puro; importar lucide-react ali
// arrastaria a árvore de ícones para o servidor e para os testes). O preço é
// que o nome pode não existir — e aí o item cai num ícone genérico em silêncio.
const fonteSidebar = readFileSync(path.join(RAIZ, 'src', 'components', 'sidebar.tsx'), 'utf8');
const mapa = fonteSidebar.slice(
  fonteSidebar.indexOf('const ICONES'),
  fonteSidebar.indexOf('const MENU_ADMIN'),
);
for (const item of [...ROTAS_SEMPRE_VISIVEIS, ...rotasDeTools().map((r) => r)]) {
  const icone =
    item.icone ??
    Object.values(REGISTRO_TOOLS)
      .flatMap((d) => d.rotasPainel ?? [])
      .find((r) => r.href === item.href)?.icone;
  if (!icone) continue;
  ok(
    new RegExp(`\\b${icone}\\b`).test(mapa),
    `ícone "${icone}" (${item.href}) está no mapa do sidebar`,
  );
}

console.log('\n' + '-'.repeat(60));
console.log(`  ${passou} passaram, ${falhou} falharam\n`);

// exitCode e não process.exit(): com o hook de resolver de .ts registrado, sair
// abruptamente no Windows dispara assertion do libuv e mascara o resultado.
process.exitCode = falhou > 0 ? 1 : 0;
