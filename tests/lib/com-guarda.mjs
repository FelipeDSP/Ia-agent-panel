#!/usr/bin/env node
/**
 * Roda um comando qualquer sob vigilância e reprova se ele mexeu em tenant que
 * não criou.
 *
 * POR QUE WRAPPER E NÃO IMPORT. Se a guarda fosse uma função que cada teste
 * chama no início e no fim, ela não rodaria quando o teste crasha no meio — que
 * é exatamente quando o dado fica sujo (ver o defeito conhecido em
 * isolamento-pedidos.mjs:140). Medindo de fora, num processo separado, ela
 * sobrevive ao crash, ao process.exit e ao Ctrl-C, e vale para os vinte e tantos
 * testes sem editar nenhum.
 *
 * Uso:
 *   node tests/lib/com-guarda.mjs npm run teste:produtos
 *   node tests/lib/com-guarda.mjs --estrutural npm run teste:pedidos
 *
 * Saída:
 *   0  comando passou e nenhum tenant preexistente foi tocado
 *   2  a guarda encontrou divergência (prevalece sobre o código do comando)
 *   n  o código do comando, quando a guarda está limpa
 */

import { spawn } from 'node:child_process';

import { carregarEnv } from '../../scripts/lib/env.mjs';
import { abrirConexao, comparar, formatarRelatorio, tirarSnapshot } from './guarda-tenants.mjs';

carregarEnv();

const argv = process.argv.slice(2);
const apenasEstrutural = argv.includes('--estrutural');
const comando = argv.filter((a) => a !== '--estrutural' && a !== '--');

if (!comando.length) {
  console.error('\n  Uso: node tests/lib/com-guarda.mjs [--estrutural] <comando...>\n');
  process.exit(64);
}

const URL_BANCO = process.env.SUPABASE_DB_URL;
if (!URL_BANCO) {
  console.error('\n  SUPABASE_DB_URL ausente no .env.local — a guarda não roda sem ela.\n');
  process.exit(64);
}

const c = await abrirConexao(URL_BANCO);

console.log(`\n== Guarda de dado alheio ==\n  comando: ${comando.join(' ')}`);
console.log(`  escopo: ${apenasEstrutural ? 'estrutural' : 'estrutural + operacional'}\n`);

const antes = await tirarSnapshot(c, { apenasEstrutural });
console.log(`  retrato inicial: ${antes.slugs.size} tenants\n${'-'.repeat(60)}`);

/*
 * `shell: true` é obrigatório (`npm run` no Windows não é executável direto),
 * MAS com ele o Node concatena os argumentos sem escapar — é o que o próprio
 * DEP0190 avisa. Passar `spawn(cmd, args, {shell:true})` com um `cmd` que tem
 * espaço monta uma linha quebrada: `C:\Program Files\nodejs\node.exe x.mjs` faz
 * o shell procurar `C:\Program`.
 *
 * Não é hipótese: é como `tests/guarda-sabotagem.mjs` chama este wrapper
 * (`process.execPath`), e por isso os SEIS cenários dele saíam 1 — o comando
 * nunca rodava. Rodar o wrapper à mão com `node` (sem caminho) escondia o
 * defeito, porque aí não há espaço nenhum.
 *
 * A saída é montar a linha nós mesmos, com aspas em quem precisa, e entregar
 * uma string só.
 */
const linhaDeComando = comando
  .map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a))
  .join(' ');

const codigoComando = await new Promise((resolve) => {
  const p = spawn(linhaDeComando, { stdio: 'inherit', shell: true });
  p.on('close', (codigo, sinal) => resolve(sinal ? 1 : (codigo ?? 1)));
  p.on('error', (e) => {
    console.error(`\n  Falha ao executar o comando: ${e.message}`);
    resolve(127);
  });
});

console.log(`${'-'.repeat(60)}\n`);

// Mede mesmo que o comando tenha crashado — é justamente aí que a limpeza falha.
const depois = await tirarSnapshot(c, { apenasEstrutural });
await c.end();

const resultado = comparar(antes, depois);
console.log(formatarRelatorio(resultado));
console.log(`\n  comando saiu com ${codigoComando}\n`);

process.exit(resultado.divergencias.length ? 2 : codigoComando);
