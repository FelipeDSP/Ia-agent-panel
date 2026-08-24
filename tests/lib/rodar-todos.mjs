#!/usr/bin/env node
/**
 * Roda TODOS os `teste:*` do `package.json`, um de cada vez, e reporta no fim.
 *
 * POR QUE EXISTE. Até 2026-08-24 não havia comando que rodasse a suíte: eram 51
 * scripts `teste:*` e nenhum agregador. O rodapé de cada entrega listava os
 * testes que quem entrega ESCOLHE rodar, e a escolha é sempre a vizinhança da
 * mudança — estruturalmente cega para regressão à distância. O
 * `teste:retomada-pausa` ficou vermelho três dias, durante os quais as migrações
 * 48, 49, 50 e 51 foram aplicadas, e ninguém viu.
 *
 * A primeira execução deste arquivo achou TRÊS vermelhos que ninguém via, nenhum
 * relacionado ao que estava sendo entregue. Um runner que estreia verde não
 * prova nada.
 *
 * -------------------------------------------------------------------------
 * SEQUENCIAL, e não é pela contagem de conexões.
 *
 * A razão que decide é outra: `npm run guarda` tira um retrato (md5 por linha)
 * de TODOS os tenants antes e depois de um comando e reprova se ele tocou tenant
 * que não criou. Com testes concorrentes, essa guarda veria tenants efêmeros de
 * OUTRO teste aparecendo e sumindo, e passaria a acusar quem não fez nada.
 * Paralelismo é incompatível com a rede que já existe — e compraria velocidade
 * que não falta: 50 testes em ~3 minutos.
 *
 * Sem modo "rápido". Modo rápido é a lista que alguém escolhe, que é exatamente
 * o defeito que este arquivo conserta.
 *
 * -------------------------------------------------------------------------
 * `node` DIRETO, não `npm run`. Medido em 3 repetições no mesmo teste: 338ms via
 * `npm run`, 65ms via `node`. São ~274ms de overhead por teste, ~14s nos 50.
 * Todos os `teste:*` são invocação de `node` pura (conferido: quatro formas, e
 * as quatro começam com `node `), então o runner lê o comando do `package.json`
 * e executa direto. Script que não comece com `node ` REPROVA em vez de ser
 * executado torto.
 *
 * -------------------------------------------------------------------------
 * DESCOBERTA POR PADRÃO, não por lista. Varre `package.json` pelo prefixo
 * `teste:`, como o `teste:grants-n8n` varre `api_n8n_*` e o
 * `teste:views-invoker` varre `pg_class`. Teste novo entra sozinho — é a única
 * propriedade que impede reencenar o `teste:retomada-pausa`.
 *
 * Uso:
 *   npm run teste                 (tudo, menos as exclusões declaradas)
 *   npm run teste -- --com-recall (inclui o que gasta OpenAI)
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const RAIZ = fileURLToPath(new URL('../../', import.meta.url));

/* -------------------------------------------------------------------------
 * EXCLUSÕES. Cada uma com o motivo escrito ao lado, e o motivo é sobre a
 * NATUREZA do script — nunca sobre ele estar vermelho hoje. Excluir algo
 * enquanto está vermelho é a lista escolhida sumindo com o problema por outro
 * nome; o critério tem de valer com o teste verde.
 * ------------------------------------------------------------------------- */
const EXCLUSOES = [
  {
    nome: 'teste:recall',
    so_com_flag: '--com-recall',
    motivo:
      'GASTA DINHEIRO A CADA EXECUÇÃO: gera um embedding na OpenAI por pergunta, '
      + 'e exige OPENAI_API_KEY. Suíte que custa por run não é rodada por hábito, '
      + 'que é justamente o hábito que este runner existe para criar. Continua '
      + 'obrigatório ao mexer em chunking ou em plano de busca vetorial (CLAUDE.md).',
  },
  {
    nome: 'teste:acqua-pronta',
    motivo:
      'NÃO É TESTE, É RELATÓRIO — o próprio cabeçalho diz "Ele não liga nada, só '
      + 'relata". Responde "se a Acqua mandar mensagem agora, funciona?", que é uma '
      + 'pergunta sobre o estado do mundo e muda quando alguém conecta ou desconecta '
      + 'o cliente pelo painel. Relatório e teste têm públicos diferentes: um informa, '
      + 'o outro reprova. Sai por essa natureza, e sairia igual estando verde.',
  },
];

/*
 * ANTI-VACUIDADE. Se a varredura achar pouca coisa, ela está quebrada — leu o
 * arquivo errado, o prefixo mudou, o JSON veio truncado — e "0 falharam" seria
 * verdade por não ter medido nada.
 *
 * O número é PISO de sanidade, não meta: em 24/08/2026 havia 51. Ele só sobe
 * quando alguém remover testes de propósito, e nesse dia a subida é deliberada.
 */
const MINIMO_ESPERADO = 40;

const args = process.argv.slice(2);
const pacote = JSON.parse(fs.readFileSync(new URL('package.json', `file://${RAIZ.replace(/\\/g, '/')}`), 'utf8'));
const scripts = pacote.scripts ?? {};

let ok = 0;
const problemas = [];
const falha = (m) => { problemas.push(m); console.log(`  FALHA ${m}`); };
const passa = (m) => { ok++; console.log(`  OK    ${m}`); };

console.log('\n== Suíte completa ==\n');

/* -- 1. a varredura, e as asserções sobre ela própria -------------------- */
const todos = Object.keys(scripts).filter((k) => k.startsWith('teste:')).sort();
console.log(`  ${todos.length} script(s) \`teste:*\` no package.json\n`);

if (todos.length < MINIMO_ESPERADO) {
  falha(`a varredura achou só ${todos.length} scripts (piso de sanidade: ${MINIMO_ESPERADO}) — ela está quebrada, não o projeto`);
  process.exit(1);
}

// Exclusão órfã REPROVA: script renomeado ou removido deixa a linha para trás, e
// lista que ninguém poda é a mesma doença do ROTAS_SEMPRE_VISIVEIS.
for (const e of EXCLUSOES) {
  if (!todos.includes(e.nome)) {
    falha(`exclusão órfã: \`${e.nome}\` não existe mais no package.json — remova a linha de EXCLUSOES`);
  }
  if (!e.motivo || e.motivo.trim().length < 80) {
    falha(`exclusão \`${e.nome}\` sem motivo escrito`);
  }
}
if (problemas.length) process.exit(1);

const excluidos = new Map(EXCLUSOES.map((e) => [e.nome, e]));
const aRodar = todos.filter((n) => {
  const e = excluidos.get(n);
  if (!e) return true;
  return Boolean(e.so_com_flag && args.includes(e.so_com_flag));
});

for (const e of EXCLUSOES) {
  const dentro = aRodar.includes(e.nome);
  console.log(`  ${dentro ? 'INCLUÍDO por flag' : 'excluído'}: ${e.nome}`);
  if (!dentro) console.log(`      ${e.motivo.replace(/(.{92})\s/g, '$1\n      ')}`);
}

/* -- 2. execução, uma de cada vez ---------------------------------------- */
console.log(`\n  rodando ${aRodar.length}, sequencial\n`);
console.log('    tempo     resultado   teste');
console.log('    ' + '-'.repeat(72));

const resultados = [];
for (const nome of aRodar) {
  const cmd = scripts[nome].trim();
  if (!cmd.startsWith('node ')) {
    // Não tente adivinhar: um script que não é `node ...` seria executado torto
    // e o verde dele não valeria nada.
    resultados.push({ nome, ms: 0, code: null, resumo: 'NÃO É `node ...`', saida: cmd });
    console.log(`    ${'—'.padStart(8)}  ${'INVÁLIDO'.padEnd(10)}  ${nome}`);
    continue;
  }
  const [, ...partes] = cmd.split(/\s+/);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, partes, {
    cwd: RAIZ, encoding: 'utf8', timeout: 300_000, env: process.env,
  });
  const ms = Date.now() - t0;
  const saida = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const m = saida.match(/(\d+) passaram, (\d+) falharam/);
  const resumo = r.error?.code === 'ETIMEDOUT' ? 'TIMEOUT' : (m ? `${m[1]}/${m[2]}` : '');
  resultados.push({ nome, ms, code: r.status, resumo, saida });
  const marca = r.status === 0 ? 'ok' : 'FALHOU';
  console.log(`    ${(`${(ms / 1000).toFixed(1)}s`).padStart(8)}  ${marca.padEnd(10)}  ${nome.padEnd(28)} ${resumo}`);
}

/* -- 3. o que falhou, com a saída ---------------------------------------- */
const falharam = resultados.filter((r) => r.code !== 0);
if (falharam.length) {
  console.log(`\n  ${'='.repeat(74)}`);
  console.log(`  ${falharam.length} TESTE(S) FALHARAM — a saída de cada um:\n`);
  for (const r of falharam) {
    console.log(`  ${'-'.repeat(74)}`);
    console.log(`  ${r.nome}  (exit=${r.code}${r.resumo ? `, ${r.resumo}` : ''})\n`);
    // As linhas que interessam: o que o teste marcou como falha. O resto do
    // stdout é ruído quando são cinquenta testes.
    const linhas = r.saida.split(/\r?\n/).filter((l) => /^\s*(FALHA|!|AVISO)/.test(l) || /ERRO|Error:/.test(l));
    (linhas.length ? linhas.slice(0, 12) : r.saida.split(/\r?\n/).slice(-12)).forEach((l) => console.log(`    ${l}`));
  }
}

/* -- 4. o rodapé, SEMPRE ------------------------------------------------- */
/*
 * Tempo total e os cinco mais lentos saem sempre, verde ou vermelho, e não são
 * asserção: são informação que envelhece à vista. Hoje são ~3 minutos com 50
 * testes; daqui a três meses serão 70 e alguns terão crescido. Suíte de 3
 * minutos roda, a de 15 não — e o dia em que passar do limite precisa ser
 * visível ANTES de virar "ninguém roda mais".
 */
const totalMs = resultados.reduce((a, r) => a + r.ms, 0);
console.log(`\n  ${'='.repeat(74)}`);
console.log(`  ${resultados.length - falharam.length} de ${resultados.length} passaram`
  + `   ·   ${(totalMs / 1000).toFixed(1)}s (${(totalMs / 60_000).toFixed(1)} min)`);
console.log('\n  os 5 mais lentos:');
resultados.slice().sort((a, b) => b.ms - a.ms).slice(0, 5)
  .forEach((r) => console.log(`    ${(`${(r.ms / 1000).toFixed(1)}s`).padStart(7)}  ${r.nome}`));
if (falharam.length) {
  console.log('\n  falharam:');
  falharam.forEach((r) => console.log(`    ${r.nome}${r.resumo ? `  (${r.resumo})` : ''}`));
}
console.log();
process.exit(falharam.length ? 1 : 0);
