#!/usr/bin/env node
/**
 * Valida um export do n8n contra os erros que ja mordreram este projeto.
 *
 * Checa:
 *   1. referencias $('Nome') a nos que nao existem      (o bug do $('Webhook1'))
 *   2. conexoes apontando para no inexistente
 *   3. queryReplacement em formato string               (o bug da virgula)
 *   4. query com multiplos statements + parametro       (extended query protocol)
 *   5. onError engolindo erro em no de log/billing
 *   6. tenant_id vindo de $fromAI                       (vazamento cross-tenant)
 *
 * Uso:  node scripts/n8n-validar.mjs n8n/workflows/*.json
 * Sai com codigo 1 se achar problema — da pra usar em CI.
 */

import { readFileSync } from 'node:fs';

const arquivos = process.argv.slice(2);
if (arquivos.length === 0) {
  console.error('uso: node scripts/n8n-validar.mjs <arquivo.json> [...]');
  process.exit(1);
}

let totalProblemas = 0;

for (const caminho of arquivos) {
  console.log(`\n${caminho}`);
  const problemas = [];

  let wf;
  try {
    wf = JSON.parse(readFileSync(caminho, 'utf8'));
  } catch (e) {
    console.log(`  ERRO: JSON invalido — ${e.message}`);
    totalProblemas++;
    continue;
  }

  const nodes = wf.nodes ?? [];
  const nomes = new Set(nodes.map((n) => n.name));
  const bruto = JSON.stringify(wf);

  // 1. referencias orfas
  const refs = new Set([...bruto.matchAll(/\$\('((?:[^'\\]|\\.)+)'\)/g)].map((m) => m[1]));
  for (const r of refs) {
    if (!nomes.has(r)) problemas.push(`referencia orfa: $('${r}') — no nao existe`);
  }

  // 2. conexoes quebradas
  for (const [origem, tipos] of Object.entries(wf.connections ?? {})) {
    if (!nomes.has(origem)) problemas.push(`conexao a partir de no inexistente: "${origem}"`);
    for (const ramos of Object.values(tipos)) {
      for (const ramo of ramos ?? []) {
        for (const c of ramo ?? []) {
          if (!nomes.has(c.node)) problemas.push(`conexao aponta para no inexistente: "${c.node}"`);
        }
      }
    }
  }

  for (const n of nodes) {
    const p = n.parameters ?? {};

    // 3. queryReplacement precisa ser array
    const qr = p.options?.queryReplacement;
    if (typeof qr === 'string' && qr.trim() && !/^=\{\{\s*\[/.test(qr.trim())) {
      problemas.push(`"${n.name}": queryReplacement em string — use array ={{ [ ... ] }}`);
    }

    // 4. multiplos statements com parametro
    if (typeof p.query === 'string' && qr) {
      const semComentario = p.query
        .split('\n')
        .filter((l) => !l.trim().startsWith('--'))
        .join('\n')
        .trim()
        .replace(/;\s*$/, '');
      if (semComentario.includes(';')) {
        problemas.push(`"${n.name}": query com multiplos statements + parametro`);
      }
    }

    // 4b. aridade e expressao decapitada no queryReplacement
    //
    // POR QUE ISTO EXISTE. O `Registra Mensagem` passou tres commits com um
    // elemento a mais na lista: `.item.json.lista_depois`, sem o `$('Lista
    // Depois')` na frente. Sobrou de uma insercao minha que emitiu DOIS
    // elementos onde cabia um. A expressao inteira deixa de avaliar — nao e
    // "um parametro errado", e o no todo parando.
    //
    // Nao foi pego por nada: a checagem de referencia orfa procura `$('X')`
    // com X inexistente, e aqui o `$('X')` simplesmente nao existe. E o
    // gerador so preserva este campo, entao regerar nao consertava.
    //
    // Duas checagens, porque pegam coisas diferentes: a aridade acha elemento
    // sobrando ou faltando mesmo que cada um seja valido; a decapitacao acha
    // expressao quebrada mesmo com a contagem certa.
    if (typeof p.query === 'string' && typeof qr === 'string' && qr.includes('[')) {
      const dentro = qr.slice(qr.indexOf('[') + 1, qr.lastIndexOf(']'));

      // Split so nas virgulas de topo — `$('X')` e chamadas aninhadas tem as suas.
      const elems = [];
      let atual = '';
      let prof = 0;
      let aspa = null;
      for (const ch of dentro) {
        if (aspa) { atual += ch; if (ch === aspa) aspa = null; continue; }
        if (ch === "'" || ch === '"' || ch === '`') { aspa = ch; atual += ch; continue; }
        if ('([{'.includes(ch)) prof++;
        if (')]}'.includes(ch)) prof--;
        if (ch === ',' && prof === 0) { elems.push(atual.trim()); atual = ''; continue; }
        atual += ch;
      }
      if (atual.trim()) elems.push(atual.trim());

      const usados = [...p.query.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
      const maior = usados.length ? Math.max(...usados) : 0;
      if (maior > 0 && elems.length !== maior) {
        problemas.push(
          `"${n.name}": query usa $1..$${maior} mas queryReplacement tem ${elems.length} elemento(s)`
        );
      }

      // Um elemento que comeca em `.` ou `)` perdeu o objeto da frente.
      elems.forEach((e, i) => {
        if (/^[.)]/.test(e)) {
          problemas.push(`"${n.name}": queryReplacement[${i}] decapitado: "${e}"`);
        }
      });
    }

    // 4c. o corpo de todo no Code precisa ao menos COMPILAR
    //
    // POR QUE ISTO EXISTE. Em 12/08/2026 o `Consolida Resultado` foi para o JSON
    // com escapamento perdido — os `\n` viraram quebra de linha real dentro de
    // uma string. O no morreu com "Unterminated string constant" e derrubou o
    // `busca_conhecimento`, que e tool BASELINE: a busca na base parou para
    // TODOS os tenants ao mesmo tempo.
    //
    // Nada pegou antes do import. O validador conferia estrutura, o
    // n8n:sincronia conferia coerencia entre agents — nenhum dos dois olhava se
    // o codigo dentro do no era JavaScript valido. Compilar e barato e pega a
    // classe inteira, em qualquer no Code de qualquer workflow.
    //
    // `new Function` COMPILA, nao executa: nenhum efeito colateral. Os
    // identificadores do n8n entram como parametros so para o parse nao
    // reclamar de nome desconhecido.
    if (typeof p.jsCode === 'string') {
      try {
        // eslint-disable-next-line no-new-func
        new Function('$input', '$json', '$node', '$workflow', '$execution', p.jsCode);
      } catch (e) {
        problemas.push(`"${n.name}": o codigo do no nao compila — ${e.message}`);
      }

      // Node Code sem `return` entrega vazio, e vazio nao levanta erro: o fluxo
      // segue com nada e o sintoma aparece muito depois.
      //
      // Os COMENTARIOS saem antes da busca. A primeira versao procurava a
      // palavra no codigo cru e uma sabotagem passou por baixo: comentar o
      // `return` deixa a palavra la, dentro do `//`, e a checagem se dava por
      // satisfeita enquanto o no passava a entregar vazio.
      const semComentarios = p.jsCode
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
      if (!/\breturn\b/.test(semComentarios)) {
        problemas.push(`"${n.name}": o codigo do no nao tem return fora de comentario — entregaria vazio`);
      }
    }

    // 5. onError engolindo erro onde nao deve
    if (n.onError === 'continueRegularOutput' && /log|registra|billing|consumo/i.test(n.name)) {
      problemas.push(`"${n.name}": onError engolindo erro em no de log/billing`);
    }

    // 6. tenant_id vindo do modelo
    const inputs = p.workflowInputs?.value ?? {};
    for (const [campo, valor] of Object.entries(inputs)) {
      if (/tenant_id|conversation_id|account_id/.test(campo) && String(valor).includes('$fromAI')) {
        problemas.push(`"${n.name}": ${campo} vindo de $fromAI — vazamento cross-tenant`);
      }
    }
  }

  if (problemas.length === 0) {
    console.log(`  OK — ${nodes.length} nos, nenhum problema conhecido`);
  } else {
    for (const p of problemas) console.log(`  PROBLEMA  ${p}`);
    totalProblemas += problemas.length;
  }
}

console.log(
  totalProblemas === 0
    ? '\nTudo certo.'
    : `\n${totalProblemas} problema(s). Corrija antes de importar.`
);
process.exit(totalProblemas > 0 ? 1 : 0);
