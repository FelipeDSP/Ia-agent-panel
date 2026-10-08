/**
 * As detecções do assistente (08/10) — o que o sistema SABE sem perguntar à LLM.
 *
 * Cada caso deste teste é um defeito que existiu de verdade num cliente, e a
 * conta de onde ele veio está escrita junto. Teste de detecção escrito com
 * exemplo inventado mede o exemplo inventado.
 *
 * As duas direções em todo caso: o achado aparece quando deve, e NÃO aparece
 * quando não deve. Detector que acusa sempre é tão inútil quanto o que nunca
 * acusa, e só a segunda metade separa os dois.
 */
import { detectar, ordenar, PESO, chaveDeOrigem } from '../src/lib/assistente/deteccoes.ts';

let ok = 0;
const falhas = [];
const chk = (nome, cond, extra = '') => {
  if (cond) { ok++; console.log(`  ok    ${nome}`); }
  else { falhas.push(nome); console.log(`  FALHA ${nome}${extra ? ' — ' + extra : ''}`); }
};

/** Uma conta sem problema nenhum: a base de toda contraprova. */
const LIMPA = {
  prompt: 'Você é a Ana, atendente da loja. Seja cordial e objetiva.',
  horario: null,
  toolsAtivas: ['busca_conhecimento'],
  vendas: null,
  produtos: [],
  documentos: [{ nome: 'Endereço', status: 'concluido', chunksJob: 1, chunksTabela: 1 }],
  barradas: [],
};
const chaves = (c) => detectar(c).map((a) => a.chave).sort();
const tem = (c, k) => chaves(c).includes(k);

console.log('\n=== 0. A conta limpa não acusa nada ===\n');

// Esta é a asserção que dá sentido a todas as outras. Sem ela, "o detector
// achou X" seria verdade também num detector que acha tudo em tudo.
chk('conta sem problema: zero achados', detectar(LIMPA).length === 0, JSON.stringify(chaves(LIMPA)));

console.log('\n=== 1. Marcadores no prompt (estud.you e CEEJAAR) ===\n');

const comPh = { ...LIMPA, prompt: 'Catálogo vigente:\n\n{{CATALOGO_DE_CURSOS}}\n\nConsulte exclusivamente este catálogo. SLA: {{SLA}}' };
chk('acusa os marcadores', tem(comPh, 'prompt_placeholders'));
chk('...e cita o nome deles no detalhe',
  detectar(comPh).find((a) => a.chave === 'prompt_placeholders')?.detalhe.includes('{{CATALOGO_DE_CURSOS}}'));
// A CONTAGEM, e não só a presença. Sem ela, um regex guloso (`[\s\S]*`) casa
// do primeiro `{{` ao último `}}` e devolve UM achado com meio prompt dentro —
// e as duas asserções acima continuam passando, porque o texto gigante COMEÇA
// com `{{CATALOGO_DE_CURSOS}}`. Foi uma sabotagem que passou que mostrou isto.
chk('o título conta DOIS marcadores, não um gigante',
  detectar(comPh).find((a) => a.chave === 'prompt_placeholders')?.titulo.includes('2 marcadores'),
  detectar(comPh).find((a) => a.chave === 'prompt_placeholders')?.titulo);
chk('dois marcadores distantes não viram um só',
  (() => {
    const longe = { ...LIMPA, prompt: '{{UM}}' + 'x'.repeat(3000) + '{{DOIS}}' };
    return detectar(longe).find((a) => a.chave === 'prompt_placeholders')?.titulo.includes('2 marcadores');
  })());
chk('é ERRO, não aviso', detectar(comPh).find((a) => a.chave === 'prompt_placeholders')?.gravidade === 'erro');
// O caso do CEEJAAR: marcador é uma frase, com espaço, acento e pontuação.
chk('marcador-frase também é pego', tem({ ...LIMPA, prompt: 'Custo: {{GRATUITO? HÁ TAXA?}}' }, 'prompt_placeholders'));
chk('CONTRAPROVA: chave de JSON no prompt não é marcador',
  !tem({ ...LIMPA, prompt: 'Responda em json: { "ok": true }' }, 'prompt_placeholders'));

console.log('\n=== 2. Horário em dois lugares (Empório, 07/10) ===\n');

const HORARIO = { janelas: [{ dias: [2, 3, 4, 5], inicio: '07:00', fim: '10:00' }] };
const promptComHora = 'Horários de retirada: ter-sex 7h-10h e 16h-19h · sáb e dom 8h-11h';
chk('com horário configurado E escrito no prompt: acusa',
  tem({ ...LIMPA, horario: HORARIO, prompt: promptComHora }, 'horario_em_dois_lugares'));
// A contraprova que importa: SEM configuração, o prompt é o único lugar onde o
// horário pode estar, e acusar ali seria mandar o cliente apagar a informação.
chk('CONTRAPROVA: sem horário configurado, o prompt pode falar de hora',
  !tem({ ...LIMPA, horario: null, prompt: promptComHora }, 'horario_em_dois_lugares'));
chk('CONTRAPROVA: com horário configurado e prompt sem hora, não acusa',
  !tem({ ...LIMPA, horario: HORARIO }, 'horario_em_dois_lugares'));

console.log('\n=== 3. Pagamento em dois lugares (Empório, 08/10) ===\n');

const VENDAS = { pagamentos: ['na_retirada'], retirada_fisica: true };
chk('vendas configurada e prompt enumera forma de pagamento: acusa',
  tem({ ...LIMPA, vendas: VENDAS, prompt: 'Pagamento: aceita cartão, PIX e dinheiro.' }, 'pagamento_em_dois_lugares'));
chk('CONTRAPROVA: sem vendas configurada, não acusa',
  !tem({ ...LIMPA, vendas: null, prompt: 'Pagamento: aceita cartão, PIX e dinheiro.' }, 'pagamento_em_dois_lugares'));
chk('CONTRAPROVA: com vendas e prompt que não fala de pagamento, não acusa',
  !tem({ ...LIMPA, vendas: VENDAS }, 'pagamento_em_dois_lugares'));

console.log('\n=== 4. Catálogo (polpa duplicada, 07/10) ===\n');

const dup = {
  ...LIMPA,
  produtos: [
    { nome: 'Polpa de Morango', preco_centavos: 1250, disponivel: true },
    { nome: 'Polpa de Morango', preco_centavos: 1250, disponivel: true },
    { nome: 'Pão de queijo', preco_centavos: 150, disponivel: true },
  ],
};
chk('produto repetido: acusa', tem(dup, 'produto_duplicado'));
chk('...e diz qual', detectar(dup).find((a) => a.chave === 'produto_duplicado')?.detalhe.toLowerCase().includes('morango'));
chk('a comparação ignora caixa e espaço',
  tem({ ...LIMPA, produtos: [{ nome: 'Café', preco_centavos: 1, disponivel: true }, { nome: ' café ', preco_centavos: 1, disponivel: true }] }, 'produto_duplicado'));
chk('CONTRAPROVA: catálogo sem repetição não acusa',
  !tem({ ...LIMPA, produtos: [{ nome: 'A', preco_centavos: 1, disponivel: true }, { nome: 'B', preco_centavos: 1, disponivel: true }] }, 'produto_duplicado'));

chk('produto disponível com preço zero: acusa',
  tem({ ...LIMPA, produtos: [{ nome: 'Brinde', preco_centavos: 0, disponivel: true }] }, 'produto_sem_preco'));
chk('CONTRAPROVA: preço zero em produto INDISPONÍVEL não acusa (ninguém vai oferecer)',
  !tem({ ...LIMPA, produtos: [{ nome: 'Brinde', preco_centavos: 0, disponivel: false }] }, 'produto_sem_preco'));

chk('vende e o catálogo está vazio: acusa',
  tem({ ...LIMPA, toolsAtivas: ['vendas'], produtos: [] }, 'vendas_sem_catalogo'));
chk('CONTRAPROVA: não vende e catálogo vazio é normal',
  !tem({ ...LIMPA, toolsAtivas: ['busca_conhecimento'], produtos: [] }, 'vendas_sem_catalogo'));
chk('CONTRAPROVA: vende COM catálogo não acusa',
  !tem({ ...LIMPA, toolsAtivas: ['vendas'], produtos: [{ nome: 'X', preco_centavos: 100, disponivel: true }] }, 'vendas_sem_catalogo'));
// Produto só indisponível é catálogo vazio para quem compra.
chk('vende e só tem produto indisponível: acusa',
  tem({ ...LIMPA, toolsAtivas: ['vendas'], produtos: [{ nome: 'X', preco_centavos: 100, disponivel: false }] }, 'vendas_sem_catalogo'));

console.log('\n=== 5. Documento que a tela mostra e o agente não acha (Empório) ===\n');

// O caso real: job `concluido` com 80 chunks, zero linhas em kb_documentos.
const sumiu = { ...LIMPA, documentos: [{ nome: 'Lei da Prevenção', status: 'concluido', chunksJob: 80, chunksTabela: 0 }] };
chk('job concluído com 0 trechos na tabela: acusa', tem(sumiu, 'documento_sem_chunks'));
chk('...e é ERRO', detectar(sumiu).find((a) => a.chave === 'documento_sem_chunks')?.gravidade === 'erro');
chk('...e nomeia o documento', detectar(sumiu).find((a) => a.chave === 'documento_sem_chunks')?.detalhe.includes('Lei da Prevenção'));
chk('CONTRAPROVA: job concluído COM trechos não acusa',
  !tem({ ...LIMPA, documentos: [{ nome: 'ok', status: 'concluido', chunksJob: 3, chunksTabela: 3 }] }, 'documento_sem_chunks'));
chk('CONTRAPROVA: job com ERRO e zero trechos não acusa (já aparece como erro na tela)',
  !tem({ ...LIMPA, documentos: [{ nome: 'x', status: 'erro', chunksJob: 0, chunksTabela: 0 }] }, 'documento_sem_chunks'));

chk('base sem documento nenhum: nota', tem({ ...LIMPA, documentos: [] }, 'base_vazia'));
chk('CONTRAPROVA: com documento, não acusa base vazia', !tem(LIMPA, 'base_vazia'));

console.log('\n=== 5b. O ELO entre o job e os chunks (o erro que eu cometi) ===\n');

// Errar este elo não dá erro: dá FALSO POSITIVO. A primeira versão cruzava
// tudo por `texto:<id>` e acusou 16 de 22 documentos como sumidos — incluindo
// os 13 da estud.you, que estavam no lugar. O número certo é 3. Numa tela de
// diagnóstico isso mandaria o cliente reenviar o que já estava lá.
chk('tipo=texto -> `texto:<id>`', chaveDeOrigem({ id: 'abc', tipo: 'texto' }) === 'texto:abc');
chk('tipo=arquivo -> o caminho no Storage, NÃO o id',
  chaveDeOrigem({ id: 'abc', tipo: 'arquivo', arquivo_path: 'tenant/uuid.txt' }) === 'tenant/uuid.txt');
chk('arquivo sem caminho não cai em `texto:<id>` por engano (seria o falso positivo de volta)',
  chaveDeOrigem({ id: 'abc', tipo: 'arquivo', arquivo_path: null }) !== 'texto:abc');

// O PAR: a detecção de documento sumido precisa estar provada para os DOIS
// tipos. Provar só para `texto` é metade do par — a lição de 09/09.
chk('documento de ARQUIVO com chunks não é acusado',
  !tem({ ...LIMPA, documentos: [{ nome: 'nr 10.txt', status: 'concluido', chunksJob: 44, chunksTabela: 44 }] }, 'documento_sem_chunks'));
chk('CONTRAPROVA: o mesmo documento com 0 na tabela é acusado',
  tem({ ...LIMPA, documentos: [{ nome: 'nr 10.txt', status: 'concluido', chunksJob: 44, chunksTabela: 0 }] }, 'documento_sem_chunks'));

console.log('\n=== 6. O que o portão barrou (CEEJAAR: 13 em 3 semanas) ===\n');

const b = (n) => Array.from({ length: n }, (_, i) => ({ conversationId: i, veredito: 'barrado_regra_1', bruto: 'x' }));
chk('uma barrada: aviso', detectar({ ...LIMPA, barradas: b(1) }).find((a) => a.chave === 'portao_barrou')?.gravidade === 'aviso');
chk('três ou mais: vira erro', detectar({ ...LIMPA, barradas: b(3) }).find((a) => a.chave === 'portao_barrou')?.gravidade === 'erro');
chk('CONTRAPROVA: nenhuma barrada, nenhum achado', !tem(LIMPA, 'portao_barrou'));

console.log('\n=== 7. Ordem: erro antes de aviso antes de nota ===\n');

/*
 * A ordem NATURAL desta conta tem de ser DIFERENTE da ordenada — senão
 * `ordenar` é um no-op e tanto faz se ela muta, se inverte ou se não faz nada.
 * Foi assim na primeira versão: a fixture já saía erro-aviso-nota de
 * `detectar`, e a sabotagem "ordenar MUTA a lista" passou verde.
 *
 * `produto_duplicado` (aviso) é empilhado ANTES de `produto_sem_preco` (erro)
 * dentro de `detectar` — é esse par que desordena de propósito.
 */
const bagunca = {
  ...LIMPA,
  prompt: '{{X}} pedido',                                   // erro + nota
  produtos: [
    { nome: 'A', preco_centavos: 1, disponivel: true },
    { nome: 'a', preco_centavos: 1, disponivel: true },     // aviso (duplicado)
    { nome: 'Brinde', preco_centavos: 0, disponivel: true }, // ERRO, depois do aviso
  ],
  documentos: [],                                           // nota
};
const naturais = detectar(bagunca).map((a) => a.gravidade);
chk('a fixture esta DESORDENADA na origem (senao `ordenar` seria no-op)',
  naturais.some((g, i) => i > 0 && PESO[naturais[i - 1]] > PESO[g]), JSON.stringify(naturais));
const ord = ordenar(detectar(bagunca));
chk('a varredura ACHOU achados para ordenar (lista vazia aprovaria qualquer ordem)', ord.length >= 3, `${ord.length}`);
const pesos = ord.map((a) => PESO[a.gravidade]);
chk('a ordem é não-decrescente em gravidade', pesos.every((p, i) => i === 0 || pesos[i - 1] <= p), JSON.stringify(ord.map((a) => a.gravidade)));
chk('`ordenar` não muta a lista original', (() => { const orig = detectar(bagunca); const antes = orig.map((a) => a.chave).join(); ordenar(orig); return orig.map((a) => a.chave).join() === antes; })());

console.log('\n=== 8. Todo achado é utilizável por quem vai consertar ===\n');

const todos = detectar(bagunca);
chk('todo achado tem chave, título, detalhe e ONDE se conserta',
  todos.every((a) => a.chave && a.titulo && a.detalhe && a.onde), JSON.stringify(todos.filter((a) => !a.onde)));
chk('as chaves são únicas', new Set(todos.map((a) => a.chave)).size === todos.length);
chk('nenhum detalhe cita nome de coluna ou de função (quem lê é o lojista)',
  todos.every((a) => !/kb_documentos|tenant_id|api_n8n|jsonb|select /i.test(a.detalhe + a.titulo)),
  JSON.stringify(todos.map((a) => a.detalhe).filter((d) => /kb_documentos|api_n8n/i.test(d))));

console.log(`\n${falhas.length ? 'FALHOU' : 'passaram'}: ${ok} ok, ${falhas.length} falhas`);
if (falhas.length) { for (const f of falhas) console.log('  - ' + f); process.exit(1); }
