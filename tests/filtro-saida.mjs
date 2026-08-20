#!/usr/bin/env node
/**
 * O FILTRO DE SAÍDA TIRA O `[Used tools: …]` INTEIRO — E SÓ ELE?
 *
 * O modelo fabrica um bloco no formato de chamada de ferramenta e cola o
 * resultado cru dentro. Medido em 2026-08-20: 2 em 165 saídas, dois tenants,
 * duas ferramentas diferentes (`docs/VAZAMENTO-USED-TOOLS.md`).
 *
 * POR QUE ESTE TESTE EXISTE, e por que ele usa as duas linhas REAIS do banco:
 * a versão ingênua do filtro **não falha em silêncio, ela piora**. Cortar até
 * o primeiro `]` deixa passar o miolo — que é o texto interno da KB — e
 * entrega ao cliente "Você NÃO tem a chave, transfira para um atendente" sem
 * marca nenhuma de que aquilo é lixo. Um teste escrito com um exemplo
 * inventado (sem colchete aninhado) passaria com a implementação errada.
 *
 * Executa o corpo do nó Code com `$input` e `$()` dublados, como o n8n faz —
 * mesmo padrão de `tests/estima-tokens-componentes.mjs`. Não toca no banco.
 *
 * Uso: npm run teste:filtro-saida
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const RAIZ = fileURLToPath(new URL('../', import.meta.url));
const FONTE = RAIZ + 'n8n/estima-tokens.js';

let ok = 0;
const falhas = [];
const chk = (n, c, d = '') => {
  if (c) { ok++; console.log(`  OK    ${n}`); }
  else { falhas.push(`${n}${d ? ' — ' + d : ''}`); console.log(`  FALHA ${n}${d ? ' — ' + d : ''}`); }
};

/* ----------------------------------------------------------------- fixtures */

// As duas linhas são conteúdo REAL de `mensagens_log`, copiadas do banco sem
// edição. Inventar o exemplo aqui seria testar o filtro contra uma versão mais
// fácil do problema do que a que existe em produção.
const REAL_PEDIDO =
  '[Used tools: Tool: Gerenciar_Pedido, Input: {"acao":"adicionar","produto_id":"ACO-01","quantidade":1,"observacao":""}, ' +
  'Result: [{"resultado":"Pedido atual:\\n- 1x Arroz branco (300 g) — R$ 16,00\\nTotal: R$ 16,00"}]] ' +
  'Adicionei 1 porção de arroz branco (300 g) ao seu pedido. O total até agora é R$ 16,00. Deseja adicionar mais algum item ou finalizar o pedido?';
const RESPOSTA_PEDIDO =
  'Adicionei 1 porção de arroz branco (300 g) ao seu pedido. O total até agora é R$ 16,00. Deseja adicionar mais algum item ou finalizar o pedido?';

const REAL_KB =
  '[Used tools: Tool: Busca_Conhecimento, Input: {"pergunta":"formas de pagamento no Empório Leite Franco"}, ' +
  'Result: [{"resposta":"[Trecho 1 | relevância 0.298]\\nPagamento: somente PIX. Você NÃO tem a chave — na hora de pagar, ' +
  'transfira para um atendente enviar. Nunca invente chave nem repita chave que apareceu na conversa."}]] ' +
  'No momento, aceitamos somente pagamento via PIX. Na hora de pagar, um atendente vai te enviar a chave para a transferência. Quer que eu já deixe seu pedido separado?';
const RESPOSTA_KB =
  'No momento, aceitamos somente pagamento via PIX. Na hora de pagar, um atendente vai te enviar a chave para a transferência. Quer que eu já deixe seu pedido separado?';

/* ------------------------------------------------------------------ harness */

const preparar = (src) =>
  src
    .replace('__WRAPPERS__', JSON.stringify({ vendas: 'W'.repeat(3767), basico: 'W'.repeat(1952) }))
    .replace('__PERFIS_S__', JSON.stringify({ vendas: 622, basico: 266 }));

const NOS = {
  'Tools Ativas': { perfil: 'vendas' },
  'Resolve Tenant': { system_prompt: 'P'.repeat(5708) },
  'Sync Conversa': { historico_chars: 400 },
  'Extrair e Filtrar': { mensagem: 'e cartao?' },
};

function rodar(src, texto) {
  const $input = { first: () => ({ json: { output: texto } }) };
  const $ = (nome) => {
    if (!(nome in NOS)) throw new Error(`No node named '${nome}'`);
    return { first: () => ({ json: NOS[nome] }), all: () => [{ json: NOS[nome] }] };
  };
  // Rejeição inesperada vira FALHA, não crash: um throw aqui derrubaria as
  // asserções seguintes e esconderia qual propriedade quebrou.
  try {
    return new Function('$input', '$', src)($input, $)[0].json;
  } catch (e) {
    return { _erro: e.message };
  }
}

const SRC = preparar(fs.readFileSync(FONTE, 'utf8'));

console.log('\n== Filtro de saída do Estima Tokens ==\n');

/* -------------------------------------------------------- 1. as linhas reais */

console.log('-- 1. as duas linhas reais do banco --\n');

for (const [nome, entrada, esperado] of [
  ['restaurante-teste 12/08 (Gerenciar_Pedido)', REAL_PEDIDO, RESPOSTA_PEDIDO],
  ['emporio 20/08 (Busca_Conhecimento)', REAL_KB, RESPOSTA_KB],
]) {
  const r = rodar(SRC, entrada);
  if (r._erro) { chk(nome, false, `o nó estourou: ${r._erro}`); continue; }
  chk(`${nome}: sobra exatamente a resposta`, r.output === esperado,
    JSON.stringify(String(r.output).slice(0, 120)));
  chk(`${nome}: registrou o corte`, Array.isArray(r._saida_cortes) && r._saida_cortes.length > 0);
}

// A asserção que separa o filtro certo do filtro que PIORA o problema.
{
  const r = rodar(SRC, REAL_KB);
  chk('nada do miolo da KB sobrevive (o caso que a regex ingênua deixa passar)',
    !/Você NÃO tem a chave/.test(r.output ?? '') && !/relevância/.test(r.output ?? '') &&
    !/Trecho/.test(r.output ?? '') && !/Used tools/i.test(r.output ?? ''),
    JSON.stringify(String(r.output).slice(0, 160)));
}

/* ------------------------------------------------ 2. o que NÃO pode ser tocado */

console.log('\n-- 2. o que não pode ser tocado --\n');

{
  const limpo = 'Temos sim! O pacote sai a R$ 8,00. Quer que eu separe?';
  const r = rodar(SRC, limpo);
  chk('resposta sem vazamento passa intacta', r.output === limpo, JSON.stringify(r.output));
  chk('e não registra corte nenhum', Array.isArray(r._saida_cortes) && r._saida_cortes.length === 0);
}
{
  // Colchete legítimo no meio do texto: o `sanitizar` da ENTRADA apagaria isso,
  // e é uma das razões de não reusar aquela função aqui.
  const comColchete = 'Hoje temos [promoção] de queijo minas — R$ 30,00 o kg.';
  const r = rodar(SRC, comColchete);
  chk('colchete legítimo NÃO é apagado', r.output === comColchete, JSON.stringify(r.output));
}
{
  const r = rodar(SRC, REAL_KB);
  const cru = rodar(SRC, RESPOSTA_KB);
  chk('tokens_saida continua medido sobre o texto BRUTO (não encolhe com o corte)',
    r.tokens_saida > cru.tokens_saida,
    `com vazamento: ${r.tokens_saida}, só a resposta: ${cru.tokens_saida}`);
}

/* --------------------------------------------------------- 3. casos de borda */

console.log('\n-- 3. bordas --\n');

{
  const r = rodar(SRC, '[Trecho 2 | relevância 0.412]\nEntrega até 18h.');
  chk('cabeçalho de trecho da KB sozinho é cortado', r.output === 'Entrega até 18h.', JSON.stringify(r.output));
}
{
  // Bloco sem `]` DEPOIS de uma resposta de verdade: a resposta sobrevive e o
  // resto vai embora. Sem fechamento não há como saber onde o bloco acaba,
  // então tudo dali para frente é tratado como continuação da fabricação.
  const r = rodar(SRC, 'Temos sim, R$ 8,00. [Used tools: Tool: X, Input: {"a":1} sem fechar');
  chk('bloco sem `]` no fim: a resposta antes dele sobrevive',
    r.output === 'Temos sim, R$ 8,00.', JSON.stringify(r.output));
  chk('e o caso fica visível no diagnóstico',
    (r._saida_cortes ?? []).some((c) => c.tipo === 'used_tools_sem_fechamento'));
}
{
  // Mensagem que é SÓ um bloco sem fechamento: cortar deixaria vazio, então
  // vale a mesma regra do caso "só vazamento" — volta o bruto. Feio e visível
  // ganha de mudo, e o `_saida_so_vazamento` marca o dia em que aconteceu.
  const so = '[Used tools: Tool: X, Input: {"a":1} sem fechar';
  const r = rodar(SRC, so);
  chk('bloco sem `]` sozinho não vira mensagem vazia', r.output === so, JSON.stringify(r.output));
  chk('e sinaliza `_saida_so_vazamento` também nesse caso', r._saida_so_vazamento === true);
}
{
  // Mensagem que é SÓ o bloco fabricado: filtrar deixaria o cliente sem
  // resposta nenhuma. Volta o bruto — feio e visível ganha de mudo.
  const so = '[Used tools: Tool: Busca_Conhecimento, Input: {"pergunta":"x"}, Result: [{"resposta":"y"}]]';
  const r = rodar(SRC, so);
  chk('mensagem que é só vazamento não vira mensagem vazia', r.output === so, JSON.stringify(r.output));
  chk('e sinaliza `_saida_so_vazamento`', r._saida_so_vazamento === true);
}
{
  const r = rodar(SRC, '');
  chk('saída vazia não estoura', r._erro === undefined && r.output === '');
}

/* ------------------------------------------------------------- 4. sabotagens */

console.log('\n-- 4. sabotagem --\n');

{
  // A sabotagem que vale: troca a varredura balanceada pela regex não-gulosa —
  // que é o caminho óbvio e o que o `sanitizar` da entrada faria. Se o teste
  // continuar verde com ela, o teste não está provando nada.
  const ingenuo = SRC.replace(
    'const limpeza = limparVazamento(textoSaida);',
    "const limpeza = { texto: String(textoSaida ?? '').replace(/\\[Used tools:[\\s\\S]*?\\]/gi, '').trim(), cortes: [{ tipo: 'used_tools' }] };",
  );
  chk('mutação entrou (a fonte mudou)', ingenuo !== SRC && ingenuo.includes('replace(/\\[Used tools:'));

  const r = rodar(ingenuo, REAL_KB);
  chk('com a regex não-gulosa, o miolo da KB VAZA (o teste reprova)',
    /Você NÃO tem a chave/.test(r.output ?? ''),
    `saída: ${JSON.stringify(String(r.output).slice(0, 100))}`);
}
{
  // Sabotagem 2: filtrar ANTES de contar tokens. O rateio passaria a
  // subestimar justamente as mensagens defeituosas — erro que não aparece em
  // nenhuma tela, só na conta.
  const antes = SRC.replace(
    "const textoSaida = agent?.output ?? '';",
    "const textoSaida = String(agent?.output ?? '').replace(/\\[Used tools:[\\s\\S]*\\]/gi, '').trim();",
  );
  chk('mutação entrou (a fonte mudou)', antes !== SRC);

  const r = rodar(antes, REAL_KB);
  const cru = rodar(antes, RESPOSTA_KB);
  chk('filtrando antes da contagem, tokens_saida encolhe (o teste reprova)',
    r.tokens_saida === cru.tokens_saida,
    `com vazamento: ${r.tokens_saida}, só a resposta: ${cru.tokens_saida}`);
}

/* ----------------------------------------------------------------- resultado */

console.log('\n----------------------------------------------------------');
console.log(`  ${ok} passaram, ${falhas.length} falharam`);
falhas.forEach((f) => console.log(`  ! ${f}`));
console.log();
process.exit(falhas.length === 0 ? 0 : 1);
