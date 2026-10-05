// ============================================================================
// MENSAGEM PRONTA — ponto de convergencia dos dois caminhos
//
// ESTE ARQUIVO E A FONTE, injetado por scripts/gerar-principal.mjs.
//
// O QUE ELE E. O `Acumula Mensagem` precisa de UM lugar de onde ler `mensagem`,
// venha ela do texto digitado ou da transcricao de um audio. Dois nos alimentam
// este aqui e apenas um executa por invocacao:
//
//   Roteia Acao[0] processar ─────────────────────────────┐
//                                                          ├→ Mensagem Pronta
//   ...audio... → Filtra Transcricao (status ok) ──────────┘
//
// POR QUE ELE E PERIGOSO. E no novo no caminho de TODO cliente, e o
// `Acumula Mensagem` passou a depender dele. Se ele emitir vazio, o acumulo
// grava vazio, o agente e chamado sem prompt e a execucao morre com
// "No prompt specified" — exatamente a falha da execucao 3951563, por outra
// porta.
//
// POR ISSO ELE FALHA ALTO. Sem `mensagem` utilizavel ele LANCA, e a execucao
// aparece vermelha com a origem no texto do erro. A alternativa — emitir vazio e
// seguir — trocaria um erro visivel por um agente respondendo do nada, que e o
// modo de falha que este projeto mais pagou caro.
// ============================================================================

// ----------------------------------------------------------------------------
// DE ONDE VEM A MENSAGEM, e por que nao da para ler so o $input
// ----------------------------------------------------------------------------
// O caminho de TEXTO chega aqui assim:
//
//   Extrair e Filtrar -> Resolve Tenant [postgres] -> Tenant Valido? -> Roteia Acao
//
// O `Resolve Tenant` e um no Postgres: ele SUBSTITUI o item pela linha do
// tenant. Entao no caminho de texto o `$input` daqui carrega tenant_id, modelo e
// system_prompt — e nao a mensagem. Era exatamente por isso que o
// `Acumula Mensagem` sempre leu `$('Extrair e Filtrar')` por NOME.
//
// Ler o `$input` aqui derrubou o caminho de texto de TODOS os tenants assim que
// o workflow foi importado (execucao 3955143). A guarda abaixo pegou — que e o
// que ela existe para fazer —, mas o bug era este.
//
// O caminho de AUDIO e o oposto: o item vem do `Filtra Transcricao`, que monta
// `{ status, mensagem, audio_segundos }`. Ali o `$input` E a fonte, porque o
// texto so existe depois da transcricao.
//
// `status` e o discriminador: so o ramo de audio o produz.
const item = $input.first()?.json ?? {};
const daTranscricao = typeof item.status === 'string';

let mensagem = '';
if (daTranscricao) {
  mensagem = typeof item.mensagem === 'string' ? item.mensagem.trim() : '';
} else {
  try {
    const doTeclado = $('Extrair e Filtrar').first().json.mensagem;
    mensagem = typeof doTeclado === 'string' ? doTeclado.trim() : '';
  } catch (e) {
    mensagem = '';
  }
}

if (!mensagem) {
  // De onde veio ajuda a debugar: o caminho de texto so chega aqui com
  // `acao === 'processar'`, que garante mensagem nao vazia; entao vazio aqui
  // aponta para o ramo de audio ou para fiacao errada.
  const origem = daTranscricao
    ? `transcricao (status=${item.status})`
    : 'texto digitado (lido de Extrair e Filtrar)';
  throw new Error(
    'Mensagem Pronta sem mensagem utilizavel — origem: ' + origem + '. ' +
    'Seguir daqui gravaria acumulo vazio e chamaria o agente sem prompt. ' +
    'A execucao para de proposito; ver n8n/mensagem-pronta.js.'
  );
}

return [{
  json: {
    mensagem,
    // NULL em texto digitado — so o audio preenche. E o que alimenta o
    // mensagens_log.audio_segundos, unidade de cobranca propria que nao se soma
    // a token. Sem o `daTranscricao`, um campo homonimo vindo da linha do tenant
    // entraria aqui por engano.
    audio_segundos:
      daTranscricao && Number.isFinite(Number(item.audio_segundos)) ? Number(item.audio_segundos) : null
  }
}];
