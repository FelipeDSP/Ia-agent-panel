#!/usr/bin/env node
/**
 * A VARREDURA DA SONDA B FUNCIONA? (n8n/estima-tokens.js)
 *
 * A sonda B existe para responder, com UMA execucao real, se o numero exato de
 * tokens chega junto com a saida do agent. O risco que este teste cobre e o pior
 * possivel para uma sonda: ela varrer errado, achar zero, e o veredicto virar
 * "nao da" -- que foi a conclusao que segurou este assunto por meses.
 *
 * Nao toca no banco e nao chama o n8n: extrai `acharUsos` do arquivo-fonte e
 * exercita contra o formato que o n8n serializa, contra objeto ciclico (que
 * travaria o no e derrubaria a mensagem do cliente) e contra objeto sem uso
 * nenhum. A sabotagem no fim confirma que a assercao principal consegue falhar.
 *
 * Uso: npm run teste:sonda-tokens
 */
// Prova offline da varredura da sonda B: extrai o acharUsos do arquivo-fonte e
// exercita contra (a) o formato LangChain serializado, (b) objeto ciclico,
// (c) objeto sem uso nenhum. Sabotagem inclusa.
import fs from 'node:fs';
const src = fs.readFileSync('n8n/estima-tokens.js', 'utf8');
const ini = src.indexOf('const acharUsos =');
const fim = src.indexOf('let sonda_b;');
if (ini < 0 || fim < 0) { console.log('FALHA: nao achei o bloco acharUsos'); process.exit(1); }
const acharUsos = eval('(' + src.slice(ini, fim).replace('const acharUsos =', '').trim().replace(/;$/, '') + ')');

let ok = 0, falhas = [];
const chk = (n, c, d = '') => c ? (ok++, console.log('  OK    ' + n)) : (falhas.push(n), console.log(`  FALHA ${n} ${d}`));

// (a) o formato que o n8n serializa: AIMessage dentro de messageLog
const agent = {
  output: 'resposta ao cliente',
  intermediateSteps: [
    { action: { tool: 'consultar_catalogo', toolInput: {}, messageLog: [ { lc: 1, kwargs: {
        content: '', response_metadata: { tokenUsage: { promptTokens: 1554, completionTokens: 31 } } } } ] },
      observation: 'lista' },
    { action: { tool: 'gerenciar_pedido', toolInput: {}, messageLog: [ { lc: 1, kwargs: {
        content: '', usage_metadata: { input_tokens: 1802, output_tokens: 44 } } } ] },
      observation: 'ok' },
  ],
};
const r = acharUsos(agent);
chk('acha os dois usos no formato LangChain', r.achados.length === 2, JSON.stringify(r.achados));
chk('soma entrada 1554+1802', r.achados.reduce((a,u)=>a+u.entrada,0) === 3356);
chk('soma saida 31+44', r.achados.reduce((a,u)=>a+u.saida,0) === 75);
// A ordem dos achados e por PROFUNDIDADE (busca em largura), nao por indice do
// passo: usage_metadata esta mais raso que response_metadata.tokenUsage e sai
// primeiro. Para somar tanto faz; para depurar, o que importa e o caminho citar
// o passo. Entao a assercao e sobre o CONJUNTO, nao sobre a posicao.
const caminhos = r.achados.map((u) => u.caminho).sort().join(' | ');
chk('os caminhos citam os dois passos, para depurar', 
  /intermediateSteps\.0\..*messageLog/.test(caminhos) && /intermediateSteps\.1\..*messageLog/.test(caminhos), caminhos);

// (b) ciclo: messageLog reapontando para o proprio agent
const cic = { output: 'x', intermediateSteps: [] };
cic.self = cic; cic.intermediateSteps.push({ action: { messageLog: [cic] } });
const rc = acharUsos(cic);
chk('objeto ciclico termina sem travar', rc.visitados < 5000 && rc.achados.length === 0, JSON.stringify(rc));

// (c) sem uso nenhum: nao inventa numero
const rv = acharUsos({ output: 'so texto', intermediateSteps: [{ action: { tool: 't' }, observation: 'o' }] });
chk('sem uso nenhum devolve zero achados', rv.achados.length === 0);

// (d) SABOTAGEM: se a varredura parasse de reconhecer usage_metadata, (a) cairia para 1
const sabotado = eval('(' + src.slice(ini, fim).replace('const acharUsos =','').trim().replace(/;$/,'')
  .replace('v.input_tokens ?? ', '').replace('v.output_tokens ?? ', '') + ')');
const rs = sabotado(agent);
chk('sabotagem (perder usage_metadata) e detectada', rs.achados.length === 1,
    `sabotado achou ${rs.achados.length}, esperado 1`);

console.log('\n' + '-'.repeat(50));
console.log(`  ${ok} passaram, ${falhas.length} falharam`);
process.exitCode = falhas.length ? 1 : 0;
