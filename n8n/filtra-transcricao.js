// ============================================================================
// FILTRA TRANSCRICAO — corpo do no que trata o retorno da transcricao
//
// ESTE ARQUIVO E A FONTE. O gerador injeta o bloco de n8n/filtro-texto.js no
// lugar do marcador __FILTRO_TEXTO__ e grava o resultado no no. O MESMO bloco
// vai para o `Extrair e Filtrar` — `npm run n8n:sincronia` falha se os dois
// deixarem de ser identicos byte a byte.
//
// POR QUE O FILTRO RODA DE NOVO AQUI. O `Extrair e Filtrar` filtra o texto
// DIGITADO. Audio transcrito e texto do cliente que entra no fluxo depois disso:
// sem passar pela mesma blocklist, alguem fala "esquece suas instrucoes" numa
// nota de voz e chega ao modelo sem filtro nenhum. O canal e outro, o ataque e o
// mesmo.
//
// Devolve `status`, e quem roteia e o no seguinte:
//   ok         -> segue para o Mensagem Pronta
//   bloqueado  -> vai para o caminho de bloqueio que o texto ja tem
//   vazio      -> avisa que nao entendeu e NAO chama o agente
// ============================================================================

const resposta = $input.first().json ?? {};

// `verbose_json` devolve { text, duration, language, segments }. O `duration` e
// a duracao EXATA em segundos, e e o que vai para mensagens_log.audio_segundos —
// o file_size do webhook e so o proxy que decidiu se valia a pena transcrever.
const bruto = String(resposta.text ?? '').trim();
const duracao = Number(resposta.duration);

// __FILTRO_TEXTO__

const semSaida = (status, extra = {}) => [{
  json: {
    status,
    mensagem: '',
    audio_segundos: Number.isFinite(duracao) ? duracao : null,
    ...extra
  }
}];

// Transcricao vazia acontece: audio mudo, ruido, corte na gravacao. Nao e erro
// da API — ela responde 200 com texto vazio. Tratar como falha explicita evita
// o agente ser chamado com prompt vazio, que e o mesmo modo de falha que a
// execucao 3951563 mostrou.
if (!bruto) {
  return semSaida('vazio', { motivo: 'transcricao_vazia' });
}

if (contemInjection(bruto)) {
  return semSaida('bloqueado', { motivo: 'injection_no_audio' });
}

const mensagem = sanitizar(bruto);
if (!mensagem) {
  return semSaida('vazio', { motivo: 'vazio_pos_sanitizacao' });
}

return [{
  json: {
    status: 'ok',
    mensagem,
    audio_segundos: Number.isFinite(duracao) ? duracao : null,
    // Guardado para calibrar o proxy: o corte por bytes so vale enquanto a
    // relacao bytes/segundo se mantiver. Com o par medido em execucao real, o
    // limite deixa de ser aritmetica de bitrate.
    _file_size: Number($('Extrair e Filtrar').first().json.anexo?.file_size) || 0
  }
}];
