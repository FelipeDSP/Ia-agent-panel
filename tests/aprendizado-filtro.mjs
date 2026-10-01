/**
 * O filtro do aprendizado automático — a única coisa entre o que um atendente
 * digitou e o que o agente vai repetir para todos os clientes da empresa.
 *
 * O ciclo é silencioso por decisão do Felipe (01/10): ninguém confirma. Então
 * este teste não mede "o filtro tem a regra escrita" — mede o filtro RECUSANDO
 * frases que um atendente escreve de verdade, e ACEITANDO as que ele também
 * escreve de verdade. Sem a segunda metade o filtro poderia recusar tudo e
 * passar verde, que é o modo de falha mais provável de uma guarda assim.
 *
 *   npm run teste:aprendizado-filtro
 */
const { avaliar, dadoPessoalEm, ehCasoParticular, ehNaoResposta, textoDaEntrada, tituloDaEntrada, ancorado, numerosAncorados, palavrasDeConteudo, PISO_ANCORA, MIN_RESPOSTA, MAX_RESPOSTA } =
  await import(new URL('../agente/src/aprendizado/filtro.ts', import.meta.url).href);

let ok = 0;
const falhas = [];
const chk = (nome, cond, det = '') => {
  if (cond) { ok++; console.log(`  OK    ${nome}`); }
  else { falhas.push(nome); console.log(`  FALHA ${nome}${det ? ` — ${det}` : ''}`); }
};

const PERGUNTA = 'prazo de emissão do certificado';

console.log('\n== 1. O que NÃO pode virar base ==\n');
{
  // Dado pessoal, nas formas em que ele aparece de verdade numa conversa.
  const pessoais = [
    ['telefone', 'Pode falar com a secretaria no (69) 99364-1234 que eles resolvem para você hoje mesmo, viu?'],
    ['telefone sem parênteses', 'Anota o contato direto da coordenação: 69 3421-5566, funciona das 7h às 13h de segunda a sexta.'],
    ['cpf', 'Localizei seu cadastro pelo CPF 123.456.789-00 e o certificado já está liberado para retirada aqui.'],
    ['cpf sem pontuação', 'Consta aqui no sistema o documento 12345678900 com a matrícula ativa desde o ano passado.'],
    ['email', 'Mande os documentos digitalizados para secretaria.ceejaar@exemplo.com que damos andamento no pedido.'],
    ['cep', 'O endereço para correspondência é a Av. Brasil 1200, CEP 76870-000, aos cuidados da secretaria.'],
  ];
  for (const [nome, texto] of pessoais) {
    const v = avaliar(PERGUNTA, texto);
    chk(`recusa ${nome}`, v.publicar === false && v.motivo === 'dado_pessoal', JSON.stringify(v));
  }

  const particulares = [
    'No seu caso são 30 dias porque você entrou em agosto, então conte a partir daquela data.',
    'Para o seu pedido o prazo muda um pouco, já que ele foi aberto depois do fechamento do mês.',
    'Como você já fez as provas no semestre passado, o documento sai mais rápido do que o normal.',
    'Sua matrícula está ativa e por isso a emissão segue o fluxo normal da secretaria, sem taxa.',
    'Verifiquei aqui o seu protocolo e ele está na fila de assinatura da direção desde ontem.',
  ];
  for (const t of particulares) {
    const v = avaliar(PERGUNTA, t);
    chk(`recusa caso particular: "${t.slice(0, 42)}..."`, v.publicar === false && v.motivo === 'caso_particular', JSON.stringify(v));
  }

  const vazias = [
    'Bom dia!',
    'Vou verificar com a coordenação e já te retorno assim que tiver a resposta certinha, tudo bem?',
    'Só um momento que eu confirmo essa informação com a secretaria e volto aqui para te falar.',
  ];
  for (const t of vazias) {
    const v = avaliar(PERGUNTA, t);
    chk(`recusa não-resposta: "${t.slice(0, 40)}"`, v.publicar === false && (v.motivo === 'nao_resposta' || v.motivo === 'curta'), JSON.stringify(v));
  }

  chk('recusa resposta curta demais', avaliar(PERGUNTA, 'São 30 dias.').motivo === 'curta');
  chk('recusa resposta longa demais (conversa inteira colada)', avaliar(PERGUNTA, 'a'.repeat(MAX_RESPOSTA + 1)).motivo === 'longa');
  chk('recusa sem pergunta (texto solto não é consultável)', avaliar('   ', 'x'.repeat(MIN_RESPOSTA + 10)).motivo === 'sem_pergunta');
}

console.log('\n== 2. O que PRECISA passar (senão o filtro é só um "não" caro) ==\n');
{
  const boas = [
    'O certificado é emitido em até 30 dias úteis após a conclusão de todas as provas, e a retirada é na secretaria.',
    'Para se inscrever no provão é preciso levar RG, comprovante de residência e o histórico escolar da última série cursada.',
    'As aulas de alfabetização de adultos acontecem de segunda a quinta, das 19h às 21h, e a matrícula pode ser feita a qualquer momento.',
    'Você precisa trazer o documento original e uma cópia; sem a cópia a secretaria não consegue dar entrada no pedido.',
  ];
  for (const t of boas) {
    const v = avaliar(PERGUNTA, t);
    chk(`aceita: "${t.slice(0, 48)}..."`, v.publicar === true, JSON.stringify(v));
  }
  chk('"você precisa trazer RG" (segunda pessoa, mas REGRA GERAL) não é confundido com caso particular',
    !ehCasoParticular('Você precisa trazer RG e comprovante de residência no dia da prova.'));
  chk('contraprova dos detectores: texto limpo não dispara nenhum',
    dadoPessoalEm(boas[0]) === null && !ehCasoParticular(boas[0]) && !ehNaoResposta(boas[0]));
}

console.log('\n== 3. O texto que vai para a base ==\n');
{
  const v = avaliar(PERGUNTA, 'O certificado é emitido em até 30 dias úteis após a conclusão de todas as provas, e a retirada é na secretaria.');
  chk('leva a PERGUNTA junto (a busca casa com a dúvida do próximo cliente, não com a resposta)', v.texto.includes(`Pergunta: ${PERGUNTA}`));
  chk('leva a resposta VERBATIM — nada de reescrita', v.texto.includes('O certificado é emitido em até 30 dias úteis após a conclusão de todas as provas, e a retirada é na secretaria.'));
  chk('declara a origem no próprio texto', /atendimento humano/i.test(v.texto));
  chk('textoDaEntrada é a mesma função que o veredito usa', v.texto === textoDaEntrada(PERGUNTA, 'O certificado é emitido em até 30 dias úteis após a conclusão de todas as provas, e a retirada é na secretaria.'));
  chk('título curto e com reticência quando a pergunta é longa', tituloDaEntrada('p'.repeat(120)).length === 80 && tituloDaEntrada('p'.repeat(120)).endsWith('...'));
  chk('título com fallback quando não há pergunta', tituloDaEntrada('  ') === 'Aprendido no atendimento');
}

console.log('\n== 4. A ÂNCORA: o modelo não acrescenta fato ==\n');
{
  const DIALOGO = [
    'CLIENTE: quanto tempo demora o certificado?',
    'AGENTE: vou chamar um atendente para te ajudar com isso.',
    'ATENDENTE: O certificado e emitido em ate 30 dias uteis apos a conclusao das provas, e a retirada e na secretaria.',
  ].join('\n');

  const fiel = 'O certificado e emitido em ate 30 dias uteis apos a conclusao das provas, e a retirada e na secretaria.';
  chk('resposta fiel ao diálogo: âncora 1,0 e publica', ancorado(fiel, DIALOGO) === 1 && avaliar('prazo do certificado', fiel, DIALOGO).publicar === true);

  // O erro caro: o modelo inventa um número e uma taxa que ninguém disse.
  const inventado = 'O certificado e emitido em ate 15 dias uteis apos a conclusao das provas, mediante taxa de 20 reais na secretaria.';
  const v = avaliar('prazo do certificado', inventado, DIALOGO);
  chk('número e condição que NÃO estão no diálogo: recusa por nao_ancorado', v.publicar === false && v.motivo === 'nao_ancorado', JSON.stringify({ ancora: ancorado(inventado, DIALOGO), v }));

  // Impessoalizar é permitido: muda a forma, não o fato.
  const impessoal = 'A emissao do certificado leva ate 30 dias uteis apos a conclusao das provas; a retirada acontece na secretaria.';
  chk('reescrita impessoal do MESMO fato passa (a âncora não exige identidade)', ancorado(impessoal, DIALOGO) >= PISO_ANCORA, ancorado(impessoal, DIALOGO).toFixed(2));

  chk('resposta vazia tem âncora 0 (ausência de prova não é prova)', ancorado('', DIALOGO) === 0);
  chk('sem diálogo o filtro ainda roda, só não mede invenção', avaliar('prazo do certificado', fiel).publicar === true);
  chk('palavrasDeConteudo pega número e ignora palavra de ligação',
    palavrasDeConteudo('para voce sao 30 dias uteis').includes('30') && !palavrasDeConteudo('para voce sao 30 dias uteis').includes('para'));
  chk('acento não atrapalha: "úteis" casa com "uteis"', ancorado('prazo de 30 dias úteis', 'ATENDENTE: o prazo e de 30 dias uteis') === 1);
  // A medida dura: número é fato, e fato a mais é invencao.
  chk('numerosAncorados: 30 que existe passa; 15 que nao existe reprova',
    numerosAncorados('sao 30 dias', DIALOGO) === true && numerosAncorados('sao 15 dias', DIALOGO) === false);
  chk('numerosAncorados: resposta sem numero nenhum passa (nada a provar)', numerosAncorados('a retirada e na secretaria', DIALOGO) === true);
  chk('o numero errado reprova mesmo com a redacao toda fiel',
    avaliar('prazo do certificado', fiel.replace('30', '45'), DIALOGO).motivo === 'nao_ancorado');
}

console.log(`\n${ok} passaram, ${falhas.length} falharam\n`);
if (falhas.length) process.exit(1);
