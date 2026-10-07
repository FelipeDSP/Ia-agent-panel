/**
 * A conta SEM BALCÃO (07/10) — o que `secaoOferta` diz e o que ela para de dizer.
 *
 * O defeito: `- Só RETIRADA no local...` estava fixo em `secaoOferta`, sem
 * condição nenhuma, e entrava no prompt de TODA conta com perfil `vendas`.
 * Certo para o Empório, que tem loja; sem sentido para a estud.you, que vende
 * curso on-line. Na conversa 51 do sendbox o cliente pediu "Treinamento de
 * NR 01" e ouviu se queria "retirar no local, pois só trabalhamos com
 * retirada". A frase não veio do prompt dele nem de outro cliente: veio daqui.
 *
 * O que este teste mede, e nesta ordem de importância:
 *
 *  1. que a conta de HOJE não mudou — byte a byte. A chave nova é ausente em
 *     todas elas, e o Empório está vendendo agora. Um teste que só provasse o
 *     caso novo deixaria o caso vivo sem ninguém olhando;
 *  2. que sem balcão as palavras somem — e não só a frase principal. "retirar"
 *     aparece em quatro lugares diferentes do texto, e consertar um e esquecer
 *     três é o modo de falha provável;
 *  3. que a leitura trata a chave AUSENTE como `true`. É o que separa "a
 *     migração não mexeu em ninguém" de "todo mundo virou digital no deploy".
 *
 * A asserção 2 é por VOCABULÁRIO, não por igualdade de string: uma asserção
 * que compare o texto inteiro com o texto esperado passa a ser a implementação
 * escrita duas vezes (a tautológica que a semana de 14/08 pegou). O que vale é
 * a propriedade — a palavra "retirar" não pode chegar ao modelo numa conta que
 * não tem onde retirar.
 */
import { lerOferta, secaoOferta, mensagemDeRetirada, OFERTA_PADRAO } from '../agente/src/pedido/oferta.ts';

let ok = 0;
const falhas = [];
const chk = (nome, cond, extra = '') => {
  if (cond) { ok++; console.log(`  ok    ${nome}`); }
  else { falhas.push(nome); console.log(`  FALHA ${nome}${extra ? ' — ' + extra : ''}`); }
};

/** A config do Empório hoje, como está no banco: sem a chave nova. */
const EMPORIO = { pagamentos: ['na_retirada'], entrega: 'nao', pedir_nome: true, retirada: { endereco: 'Av. São Paulo, 2680' } };

console.log('\n=== 1. A chave AUSENTE é "tem balcão" ===\n');

chk('o default do tipo tem balcão', OFERTA_PADRAO.retiradaFisica === true);
chk('config vazia → tem balcão', lerOferta({}).retiradaFisica === true);
chk('config null → tem balcão', lerOferta(null).retiradaFisica === true);
chk('a config viva do Empório → tem balcão', lerOferta(EMPORIO).retiradaFisica === true);
// `!== false` e não `=== true`: lixo no jsonb não pode desligar o balcão de
// quem tem loja. Só o `false` explícito desliga.
chk('retirada_fisica: "nao" (string) NÃO desliga — só o false', lerOferta({ retirada_fisica: 'nao' }).retiradaFisica === true);
chk('retirada_fisica: false desliga', lerOferta({ retirada_fisica: false }).retiradaFisica === false);

console.log('\n=== 2. A conta com balcão não mudou uma vírgula ===\n');

// O texto de 06/10, copiado do arquivo ANTES da mudança. Não é "o que a função
// devolve agora" — é o que o Empório recebia ontem. Comparar com a própria
// saída de hoje provaria só que a função é igual a si mesma.
const ANTES_EMPORIO = [
  '## Como esta loja vende (regras desta conta)',
  '- Para MUDAR a quantidade de um item que já está no pedido ("são 20", "faz 5 em vez de 3"), chame gerenciar_pedido com acao=adicionar, o mesmo produto_id e a quantidade TOTAL nova — ela substitui a anterior. Nunca diga que alterou, anotou ou registrou sem o retorno da ferramenta mostrando a quantidade nova.',
  '- Só RETIRADA no local. Nunca pergunte endereço, nunca prometa entrega, nunca invente taxa.',
  '- Se o cliente quiser ENTREGA: diga que por aqui só há retirada no local e pergunte se quer retirar. Não transfira por isso.',
  '- Antes de fechar, pergunte EM NOME DE QUEM fica o pedido (quem vai retirar) e passe em nome_retirada. Sem o nome o fechamento é recusado.',
  '- O endereço de retirada é enviado ao cliente automaticamente, em mensagem própria, assim que o pedido fecha — não o repita nem invente outro.',
  '- Foto de produto (enviar_foto_produto): a foto vai JUNTO com a sua resposta, numa mensagem só — a sua frase vira a legenda. Depois de chamar a ferramenta, escreva só uma frase curta sobre o item; não diga "enviei a foto" à parte.',
  '- Pagamento: só NA RETIRADA. Ao fechar, use pagamento="na_retirada" e diga que ele paga quando buscar. Não gere link. NUNCA diga que está pago — quem confirma é a loja, no balcão.',
].join('\n') + '\n\n';

const agoraEmporio = secaoOferta(lerOferta(EMPORIO));
chk('a seção do Empório é BYTE A BYTE a de antes da mudança', agoraEmporio === ANTES_EMPORIO,
  agoraEmporio === ANTES_EMPORIO ? '' : 'difere:\n--- esperado ---\n' + ANTES_EMPORIO + '\n--- veio ---\n' + agoraEmporio);

// A outra metade da conta com balcão: entrega para atendente.
const comAtendente = secaoOferta(lerOferta({ ...EMPORIO, entrega: 'atendente' }));
chk('entrega=atendente continua transferindo', /chame transferir_humano com o resumo "cliente quer entrega"/.test(comAtendente));

console.log('\n=== 3. Sem balcão, as palavras somem ===\n');

const SEM = { pagamentos: ['na_retirada'], entrega: 'atendente', pedir_nome: true, retirada_fisica: false };
const semBalcao = secaoOferta(lerOferta(SEM));

// A primeira versão desta seção proibia o VOCABULÁRIO ("retirar", "buscar",
// "balcão") no texto sem balcão, e reprovou — porque a linha nova PRECISA
// nomear o que proíbe ("nunca fale em buscar, loja, frete"). A asserção estava
// medindo a coisa errada: o defeito nunca foi a palavra aparecer, foi a
// instrução de retirada ser INCONDICIONAL.
//
// Então a medida é essa, e ela é exatamente o defeito de 07/10: comparar os
// dois textos gerados pela MESMA config, mudando só o flag, e exigir que
// nenhuma linha COMUM aos dois fale de retirada. A linha de hoje aparecia nos
// dois — era comum — e teria reprovado aqui.
const comBalcao = secaoOferta(lerOferta({ ...SEM, retirada_fisica: true }));
// `split(/\r?\n/)`, nunca `split('\n')`: 174 arquivos deste repo estao em
// CRLF e o `\r` que sobra quebra comparacao de linha em silencio
// (PENDENCIA-AUTOCASAMENTO-CRLF.md). O texto aqui vem da funcao, mas a regra
// e a mesma e o habito e o que protege.
const linhasDe = (t) => t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
const semL = new Set(linhasDe(semBalcao));
const comuns = linhasDe(comBalcao).filter((l) => semL.has(l));

const PROIBIDAS = ['retirar', 'retirada', 'RETIRADA', 'buscar', 'balcão', 'endereço', 'taxa', 'ENTREGA'];
// Reprove a lista vazia ANTES de comparar: sem linhas comuns o `filter` não
// acharia nada e a guarda aprovaria o vazio que a produziu (a armadilha de
// 09/09, quando `COLUNAS_LIDAS` saiu vazia e a guarda disse que estava tudo bem).
chk('a varredura ACHOU linhas comuns aos dois textos', comuns.length > 0, `vieram ${comuns.length}`);
chk('a varredura ACHOU linhas exclusivas do texto COM balcão',
  linhasDe(comBalcao).length > comuns.length, `com=${linhasDe(comBalcao).length} comuns=${comuns.length}`);

const comunsQueFalamDeRetirada = comuns.filter((l) => PROIBIDAS.some((p) => l.includes(p)));
chk('NENHUMA linha comum aos dois fala de retirada (= nada de retirada é incondicional)',
  comunsQueFalamDeRetirada.length === 0, 'incondicionais: ' + comunsQueFalamDeRetirada.join(' | '));

// CONTRAPROVA: as palavras existem no texto com balcão. Sem isto, a asserção
// acima passaria com a função devolvendo string vazia.
const ausentesNoComBalcao = PROIBIDAS.filter((p) => !comBalcao.includes(p));
chk('CONTRAPROVA: todas as palavras aparecem no texto COM balcão', ausentesNoComBalcao.length === 0,
  'não aparecem (asserção seria vácua): ' + ausentesNoComBalcao.join(', '));

// E as frases AFIRMATIVAS de 06/10, nominalmente: são o que o cliente leu.
const AFIRMATIVAS = ['Só RETIRADA no local', 'só há retirada no local', 'quem vai retirar', 'paga quando buscar', 'O endereço de retirada é enviado'];
const sobreviveram = AFIRMATIVAS.filter((f) => semBalcao.includes(f));
chk('nenhuma das frases afirmativas de retirada sobrevive', sobreviveram.length === 0, sobreviveram.join(' | '));

chk('o texto diz, com todas as letras, que não há balcão', /não tem balcão/.test(semBalcao));
chk('e proíbe combinar hora de retirada', /nunca combine hora/i.test(semBalcao));

console.log('\n=== 4. O que sobrevive sem balcão ===\n');

// Sem balcão a venda continua existindo: o que muda é como o cliente recebe.
chk('a regra da quantidade (18/09, conversa 39) continua', /quantidade TOTAL nova/.test(semBalcao));
chk('a regra da foto continua', /enviar_foto_produto/.test(semBalcao));
chk('pedir_nome continua exigindo o nome', /EM NOME DE QUEM fica o pedido/.test(semBalcao));
chk('...mas sem o parêntese "(quem vai retirar)"', !/quem vai retirar/.test(semBalcao));
chk('pagamento na_retirada vira "combinado com a equipe"', /combinado com a equipe/.test(semBalcao));
chk('e continua proibindo dizer que está pago', /NUNCA diga que está pago/.test(semBalcao));

// Os dois pagamentos, sem balcão.
// A LINHA de pagamento, não a seção: a linha de proibição também diz "buscar",
// e medir a seção inteira confundiria uma com a outra.
const linhaPg = (t) => linhasDe(t).find((l) => l.startsWith('- Pagamento:')) ?? '';
const doisPg = linhaPg(secaoOferta(lerOferta({ pagamentos: ['link', 'na_retirada'], retirada_fisica: false })));
chk('a varredura ACHOU a linha de pagamento', doisPg.length > 0);
chk('com as duas formas, a escolha não fala em buscar', /depois, combinado com a equipe/.test(doisPg) && !doisPg.includes('buscar'));

// Endereço cadastrado numa conta sem balcão é config incoerente — o painel
// recusa, mas jsonb editado à mão e conta que desligou o balcão depois não
// passam pelo painel. Foi esta asserção que achou o furo na implementação.
const incoerente = lerOferta({ retirada_fisica: false, retirada: { endereco: 'Rua X, 1' } });
chk('CONTRAPROVA: com balcão, o mesmo endereço PRODUZ a linha',
  secaoOferta(lerOferta({ retirada: { endereco: 'Rua X, 1' } })).includes('endereço de retirada'));
chk('endereço gravado por engano não ressuscita a linha de retirada', !secaoOferta(incoerente).includes('endereço de retirada'));
chk('...nem a mensagem de endereço que vai ao cliente ao fechar', mensagemDeRetirada(incoerente) === null);
chk('CONTRAPROVA: com balcão, a mensagem de endereço existe',
  (mensagemDeRetirada(lerOferta({ retirada: { endereco: 'Rua X, 1' } })) ?? '').includes('Rua X, 1'));

console.log(`\n${falhas.length ? 'FALHOU' : 'passaram'}: ${ok} ok, ${falhas.length} falhas`);
if (falhas.length) { for (const f of falhas) console.log('  - ' + f); process.exit(1); }
