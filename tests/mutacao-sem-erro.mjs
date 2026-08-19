/**
 * Toda mutação em Server Action tem o erro destruturado E lido.
 *
 * A REGRA: `.insert`, `.update`, `.delete` e `.upsert` do supabase-js devolvem
 * `{ data, error }` e NÃO lançam. `await supabase.from('t').delete()` sem
 * destructuring compila, passa no lint, roda, e engole a falha inteira.
 *
 * POR QUE EXISTE: em 18/08 o `verificarTimeSalvo` gravava o selo assim e
 * devolvia "confirmado no Chatwoot" quando a escrita falhava. Consertado, eu
 * varri "os irmãos" — e a varredura foi por VIZINHANÇA DE ARQUIVO, não por
 * padrão: conferi `painel/acoes.ts` e não vi o `.delete()` de
 * `tenant_credenciais` em `admin/acoes.ts`, que ao falhar deixa o token de um
 * cliente excluído no banco enquanto a tela redireciona com cara de sucesso.
 * Varredura manual responde de onde a pessoa estava olhando. Esta responde do
 * repositório.
 *
 * COMO ACHA. Anda na AST do TypeScript (`typescript` já é dependência), não em
 * regex: comentário e string não são nós, e este repositório já teve regex
 * casando com comentário em vez de código duas vezes. A âncora é estreita —
 * uma chamada `insert|update|delete|upsert` cuja expressão é DIRETAMENTE um
 * `.from(…)`, que é como o supabase-js encadeia. Isso descarta de graça
 * `Set.delete`, `FormData.delete`, `URLSearchParams.delete` e `Array.from`.
 *
 * ONDE PROCURA: arquivos cujo PRÓLOGO tem a diretiva `'use server'` — lido da
 * AST, não por busca de texto. A diferença não é teórica: em `src/` a string
 * "use server" aparece em vários arquivos que NÃO têm a diretiva, alguns deles
 * documentando exatamente isso num comentário. Descobrir por diretiva também
 * corrige o defeito que originou este teste: `src/lib/tenants/prompt-acoes.ts`
 * é Server Action e não mora em `app/`.
 *
 * ============================ O QUE ELA NÃO PEGA ============================
 *
 * 1. NÃO PROVA QUE O TRATAMENTO ESTÁ CERTO. `if (error) {}` passa. Ela prova
 *    que o erro é olhado, não que a decisão tomada com ele é boa.
 * 2. NÃO COBRE STORAGE NEM RPC — `supabase.storage.from(b).upload/remove` e
 *    `.rpc()` estão fora do escopo (há uso de Storage em
 *    `painel/catalogo/acoes-foto.ts`).
 * 3. NÃO COBRE A EDGE FUNCTION `supabase/functions/processar-ingestao/`, que
 *    muta e roda em outro runtime.
 * 4. NÃO PEGA MUTAÇÃO QUE AFETA ZERO LINHAS: o PostgREST não devolve erro
 *    nisso. É outra classe de falha, e ela não é vista daqui.
 * 5. NÃO EXECUTA NADA. É leitura estática: não sabe se o ramo é alcançável.
 *
 * Prometer mais do que entrega é o defeito que esta suíte vem limpando; por
 * isso os cinco ficam no cabeçalho e não numa nota de rodapé.
 *
 * Uso: npm run teste:mutacao-sem-erro
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const RAIZ = fileURLToPath(new URL('../', import.meta.url));
const DIR_SRC = path.join(RAIZ, 'src');
const MUTACOES = new Set(['insert', 'update', 'delete', 'upsert']);

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

function varrer(dir, saida = []) {
  for (const nome of readdirSync(dir)) {
    const p = path.join(dir, nome);
    if (statSync(p).isDirectory()) varrer(p, saida);
    else if (/\.tsx?$/.test(nome)) saida.push(p);
  }
  return saida;
}

const rel = (p) => path.relative(RAIZ, p).replace(/\\/g, '/');

function parse(arquivo) {
  return ts.createSourceFile(
    arquivo,
    readFileSync(arquivo, 'utf8'),
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    arquivo.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

/**
 * A diretiva no PRÓLOGO — os ExpressionStatement de string literal antes do
 * primeiro statement de verdade. É isto que separa o arquivo que É Server
 * Action do que só FALA sobre 'use server' num comentário.
 */
function temDiretivaUseServer(sf) {
  for (const st of sf.statements) {
    if (!ts.isExpressionStatement(st)) break;
    const e = st.expression;
    if (!ts.isStringLiteral(e) && !ts.isNoSubstitutionTemplateLiteral(e)) break;
    if (e.text === 'use server') return true;
  }
  return false;
}

function achaMutacoes(sf) {
  const achados = [];
  const visita = (no) => {
    if (
      ts.isCallExpression(no) &&
      ts.isPropertyAccessExpression(no.expression) &&
      MUTACOES.has(no.expression.name.text)
    ) {
      const alvo = no.expression.expression;
      const ancorado =
        ts.isCallExpression(alvo) &&
        ts.isPropertyAccessExpression(alvo.expression) &&
        alvo.expression.name.text === 'from';
      if (ancorado) achados.push({ no, metodo: no.expression.name.text });
    }
    ts.forEachChild(no, visita);
  };
  ts.forEachChild(sf, visita);
  return achados;
}

/** Sobe até o statement que contém a mutação, sem cruzar fronteira de função. */
function statementDe(no) {
  let atual = no.parent;
  while (atual) {
    if (
      ts.isArrowFunction(atual) ||
      ts.isFunctionExpression(atual) ||
      ts.isFunctionDeclaration(atual) ||
      ts.isMethodDeclaration(atual)
    ) {
      return { tipo: 'fronteira-de-funcao' };
    }
    if (ts.isVariableStatement(atual)) return { tipo: 'variavel', no: atual };
    if (ts.isExpressionStatement(atual)) return { tipo: 'expressao', no: atual };
    if (ts.isStatement(atual)) return { tipo: 'outro-statement', no: atual };
    atual = atual.parent;
  }
  return { tipo: 'sem-statement' };
}

/** O nome local ligado a `error`, ou null se não houver. */
function ligacaoDeErro(varStatement) {
  for (const d of varStatement.declarationList.declarations) {
    if (!ts.isObjectBindingPattern(d.name)) continue;
    for (const el of d.name.elements) {
      const prop = el.propertyName ? el.propertyName.getText() : el.name.getText();
      if (prop === 'error') return { local: el.name.getText(), noLigacao: el.name };
    }
  }
  return null;
}

function funcaoQueContem(no) {
  let atual = no.parent;
  while (atual) {
    if (
      ts.isFunctionDeclaration(atual) ||
      ts.isArrowFunction(atual) ||
      ts.isFunctionExpression(atual) ||
      ts.isMethodDeclaration(atual)
    ) {
      return atual;
    }
    atual = atual.parent;
  }
  return no.getSourceFile();
}

/** `error` é LIDO depois? Ligar e ignorar é o caso que motivou a distinção. */
function erroEhLido(escopo, local, noLigacao) {
  let usos = 0;
  const visita = (n) => {
    if (ts.isIdentifier(n) && n.text === local && n !== noLigacao) usos++;
    ts.forEachChild(n, visita);
  };
  ts.forEachChild(escopo, visita);
  return usos > 0;
}

// ---------------------------------------------------------------------------

console.log('\n=== 1. Arquivos classificados como Server Action (pelo prólogo) ===\n');

const todos = varrer(DIR_SRC).sort();
const serverActions = todos.filter((f) => temDiretivaUseServer(parse(f)));

for (const f of serverActions) console.log(`        ${rel(f)}`);
console.log('');

ok(serverActions.length > 0, `achou Server Actions (${serverActions.length} arquivos)`);

/*
 * A PROPRIEDADE que separa prólogo de texto: arquivo que menciona "use server"
 * SEM a diretiva não pode ser classificado. Escrita como propriedade sobre o
 * conjunto, não como lista dos arquivos de hoje — a lista envelhece.
 */
const soFalamDaDiretiva = todos.filter(
  (f) => readFileSync(f, 'utf8').includes('use server') && !temDiretivaUseServer(parse(f)),
);
const vazados = soFalamDaDiretiva.filter((f) => serverActions.includes(f));
ok(
  vazados.length === 0,
  `nenhum arquivo que só CITA 'use server' foi classificado ` +
    `(${soFalamDaDiretiva.length} citam sem ter a diretiva` +
    `${vazados.length ? ': ' + vazados.map(rel).join(', ') : ''})`,
);

console.log('\n=== 2. Toda mutação tem o erro destruturado e lido ===\n');

const naoClassificaveis = [];
let sitios = 0;

for (const arquivo of serverActions) {
  const sf = parse(arquivo);
  for (const { no, metodo } of achaMutacoes(sf)) {
    sitios++;
    const linha = sf.getLineAndCharacterOfPosition(no.getStart()).line + 1;
    const onde = `${rel(arquivo)}:${linha} .${metodo}()`;
    const st = statementDe(no);

    if (st.tipo !== 'variavel' && st.tipo !== 'expressao') {
      naoClassificaveis.push({ onde, tipo: st.tipo });
      ok(false, `${onde} — NÃO CLASSIFICÁVEL (${st.tipo}); precisa de decisão humana`);
      continue;
    }

    if (st.tipo === 'expressao') {
      ok(false, `${onde} — não destrutura o erro`);
      continue;
    }

    const lig = ligacaoDeErro(st.no);
    if (!lig) {
      ok(false, `${onde} — destrutura, mas não liga \`error\``);
      continue;
    }

    const lido = erroEhLido(funcaoQueContem(no), lig.local, lig.noLigacao);
    ok(lido, `${onde} — \`${lig.local}\` ${lido ? 'é lido' : 'é ligado e IGNORADO'}`);
  }
}

console.log('\n------------------------------------------------------------');
console.log(`  ${sitios} sítios de mutação em ${serverActions.length} Server Actions`);
if (naoClassificaveis.length) {
  console.log(`  ${naoClassificaveis.length} NÃO CLASSIFICÁVEL(EIS) — não vire exceção sozinho:`);
  for (const n of naoClassificaveis) console.log(`     ${n.onde} (${n.tipo})`);
}
console.log(`  ${passou} passaram, ${falhou} falharam`);
process.exit(falhou > 0 ? 1 : 0);
