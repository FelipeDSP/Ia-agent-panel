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

const item = $input.first()?.json ?? {};

const mensagem = typeof item.mensagem === 'string' ? item.mensagem.trim() : '';

if (!mensagem) {
  // De onde veio ajuda a debugar: o caminho de texto so chega aqui com
  // `acao === 'processar'`, que garante mensagem nao vazia; entao vazio aqui
  // aponta para o ramo de audio ou para fiacao errada.
  const origem = item.status ? `transcricao (status=${item.status})` : 'texto digitado';
  throw new Error(
    'Mensagem Pronta sem mensagem utilizavel — origem: ' + origem + '. ' +
    'Seguir daqui gravaria acumulo vazio e chamaria o agente sem prompt. ' +
    'A execucao para de proposito; ver n8n/mensagem-pronta.js.'
  );
}

return [{
  json: {
    mensagem,
    // NULL em texto digitado. So o audio preenche, e e o que alimenta o
    // mensagens_log.audio_segundos — unidade de cobranca propria, que nao se
    // soma a token.
    audio_segundos: Number.isFinite(Number(item.audio_segundos)) ? Number(item.audio_segundos) : null
  }
}];
