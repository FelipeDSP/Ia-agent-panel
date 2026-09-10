#!/usr/bin/env node
/**
 * Ordenação do catálogo — a regra vem de `src/lib/vendas/ordenar.ts`, IMPORTADA.
 *
 * Não há cópia da lógica aqui: uma cópia divergiria em silêncio da do componente
 * e o teste passaria a medir a si mesmo.
 *
 * O CONJUNTO DE TESTE FOI ESCOLHIDO PARA SEPARAR AS DUAS ORDENAÇÕES.
 * `['1','2','3']` sai igual com ordenação de texto e com numérica — passaria com
 * o defeito que esta entrega existe para evitar. `1, 2, 10, 11, 21, 40` sai
 * `1, 10, 11, 2, 21, 40` no texto e `1, 2, 10, 11, 21, 40` no número, então
 * distingue.
 *
 * Uso: npm run teste:ordenar-catalogo
 */
import {
  ORDENS,
  ORDEM_PADRAO,
  comoNumero,
  ehOrdem,
  ordenarProdutos,
} from '../src/lib/vendas/ordenar.ts';

let ok = 0;
const falhas = [];
const chk = (nome, cond, det = '') => {
  if (cond) { ok++; console.log(`  OK    ${nome}`); }
  else { falhas.push(nome); console.log(`  FALHA ${nome}${det ? ` — ${det}` : ''}`); }
};

const p = (sku, nome = `Produto ${sku}`) => ({ sku, nome });
const skus = (lista) => lista.map((x) => x.sku).join(',');

console.log('\n== Ordenação do catálogo ==\n');

// ---------------------------------------------------------------------------
console.log('-- 1. O conjunto que separa numérica de textual --\n');
{
  const entrada = ['21', '2', '40', '10', '1', '11'].map((s) => p(s));
  const saida = skus(ordenarProdutos(entrada, 'id'));
  chk('1, 2, 10, 11, 21, 40 sai em ordem NUMÉRICA', saida === '1,2,10,11,21,40', saida);

  // A contraprova: o que a ordenação de TEXTO produziria. Se o comparador
  // estivesse errado, a asserção acima falharia com exatamente esta string —
  // deixá-la escrita aqui é o que torna o defeito reconhecível no relatório.
  const comoTexto = [...entrada].sort((a, b) => a.sku.localeCompare(b.sku, 'pt-BR'));
  chk('e a ordenação de texto produziria 1,10,11,2,21,40 (a que NÃO queremos)',
    skus(comoTexto) === '1,10,11,2,21,40', skus(comoTexto));
  chk('as duas ordens são DIFERENTES (senão o teste não distinguiria nada)',
    saida !== skus(comoTexto));
}

// ---------------------------------------------------------------------------
console.log('\n-- 2. O caso misto: texto vai para o FIM --\n');
{
  const entrada = [
    p('BEB-AGUA-500', 'Água mineral 500ml'),
    p('11'), p('2'),
    p('BEB-CHOPP-300', 'Chopp Brahma 300ml'),
    p('40'), p('1'),
    p('LAV-CAM-SOC', 'Lavagem de camisa social'),
  ];
  const saida = skus(ordenarProdutos(entrada, 'id'));
  chk('numéricos primeiro em ordem numérica, texto depois em ordem alfabética',
    saida === '1,2,11,40,BEB-AGUA-500,BEB-CHOPP-300,LAV-CAM-SOC', saida);

  const pos = saida.split(',');
  const primeiroTexto = pos.findIndex((s) => !/^[0-9]+$/.test(s));
  chk('o primeiro item de texto está DEPOIS de todos os números',
    primeiroTexto === 4, `posição ${primeiroTexto}`);
  chk('nenhum texto ficou no começo', /^[0-9]/.test(pos[0]), pos[0]);
  chk('nenhum número ficou depois de um texto',
    pos.slice(primeiroTexto).every((s) => !/^[0-9]+$/.test(s)), pos.slice(primeiroTexto).join(','));
}

// ---------------------------------------------------------------------------
console.log('\n-- 3. `comoNumero` julga a string INTEIRA --\n');
chk('"12" é 12', comoNumero('12') === 12);
chk('" 7 " (com espaço) é 7', comoNumero(' 7 ') === 7);
chk('"BEB-AGUA-500" NÃO é número', comoNumero('BEB-AGUA-500') === null);
// `parseInt` diria 500 aqui, e um SKU "12A" colidiria com o 12 de verdade.
chk('"500ml" NÃO é número (parseInt diria 500)', comoNumero('500ml') === null);
chk('"12A" NÃO é número', comoNumero('12A') === null);
chk('"" NÃO é número', comoNumero('') === null);
chk('null NÃO é número', comoNumero(null) === null);

// ---------------------------------------------------------------------------
console.log('\n-- 4. Produto sem SKU vai para o fim de tudo --\n');
{
  const saida = skus(ordenarProdutos([p(null, 'Sem código'), p('5'), p('ZZZ-1')], 'id'));
  chk('null depois até dos de texto', saida === '5,ZZZ-1,', saida);
}

// ---------------------------------------------------------------------------
console.log('\n-- 5. Ordenação por nome, com acento --\n');
{
  const entrada = [p('1', 'Ovo'), p('2', 'Água'), p('3', 'Abacaxi'), p('4', 'Éclair')];
  const saida = ordenarProdutos(entrada, 'nome').map((x) => x.nome).join(',');
  chk('Abacaxi, Água, Éclair, Ovo (regras do pt-BR)', saida === 'Abacaxi,Água,Éclair,Ovo', saida);
}

// ---------------------------------------------------------------------------
console.log('\n-- 6. Contrato do seletor --\n');
chk('duas opções: ID e Nome', ORDENS.length === 2 && ORDENS.map((o) => o.rotulo).join(',') === 'ID,Nome',
  ORDENS.map((o) => o.rotulo).join(','));
chk('o padrão é ID', ORDEM_PADRAO === 'id', ORDEM_PADRAO);
chk('`ehOrdem` aceita os dois valores', ehOrdem('id') && ehOrdem('nome'));
chk('`ehOrdem` recusa lixo do localStorage', !ehOrdem('preco') && !ehOrdem(null) && !ehOrdem(''));

// ---------------------------------------------------------------------------
console.log('\n-- 7. `ordenarProdutos` não muta a lista recebida --\n');
{
  const entrada = ['3', '1', '2'].map((s) => p(s));
  const antes = skus(entrada);
  ordenarProdutos(entrada, 'id');
  chk('a lista original continua na ordem original', skus(entrada) === antes, skus(entrada));
}

// ---------------------------------------------------------------------------
console.log('\n-- 8. SABOTAGEM: trocar o comparador por ordenação de texto --\n');
// Não dá para sabotar o módulo importado em memória, então a sabotagem é sobre
// o ARQUIVO: muta, confirma que a mutação ENTROU, recarrega e exige vermelho.
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const ARQ = path.join(RAIZ, 'src', 'lib', 'vendas', 'ordenar.ts');

  const original = fs.readFileSync(ARQ, 'utf8');
  const alvo = '  if (na !== null && nb !== null) return na - nb;';
  const n = original.split(alvo).length - 1;

  if (n !== 1) {
    falhas.push('sabotagem não localizou o trecho');
    console.log(`  FALHA a sabotagem casa ${n}x, esperava 1 — o alvo mudou de forma`);
  } else {
    const mutado = original.split(alvo).join(
      "  if (na !== null && nb !== null) return String(na).localeCompare(String(nb), 'pt-BR');");
    fs.writeFileSync(ARQ, mutado);
    // CONFIRMA QUE A MUTAÇÃO ENTROU antes de acreditar no resultado. Já houve
    // sabotagem que não aplicou (CRLF, encoding) e passou por "a regra não pega".
    const relido = fs.readFileSync(ARQ, 'utf8');
    const entrou = relido !== original && relido.includes('localeCompare(String(nb)');
    chk('a sabotagem ENTROU no arquivo', entrou,
      `${original.length} -> ${relido.length} chars`);

    let saidaSabotada = null;
    try {
      // Query única para furar o cache de módulos: o import estático no topo já
      // carregou a versão original, e sem isto a "sabotagem" mediria o módulo
      // antigo e passaria por engano.
      const url = new URL('../src/lib/vendas/ordenar.ts', import.meta.url);
      url.searchParams.set('v', String(Date.now()));
      const mod = await import(url.href);
      saidaSabotada = ['21', '2', '40', '10', '1', '11'].map((s) => p(s))
        .sort((a, b) => mod.compararPorId(a.sku, b.sku)).map((x) => x.sku).join(',');
    } finally {
      fs.writeFileSync(ARQ, original);
      const restaurado = fs.readFileSync(ARQ, 'utf8');
      chk('o arquivo foi restaurado byte a byte', restaurado === original,
        `${restaurado.length} vs ${original.length}`);
    }

    chk('SABOTAGEM comparador textual -> a ordem sai 1,10,11,2,21,40 (errada)',
      saidaSabotada === '1,10,11,2,21,40', String(saidaSabotada));
  }
}

console.log(`\n${'-'.repeat(60)}`);
console.log(`  ${ok} passaram, ${falhas.length} falharam`);
if (falhas.length) { for (const f of falhas) console.log(`    - ${f}`); process.exit(1); }
