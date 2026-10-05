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

// `verbose_json` devolve { text, duration, language, segments, usage }.
//
// DOIS NUMEROS DE DURACAO, e eles NAO sao iguais. Do retorno real de 12/08:
//
//   duration        1.7799999713897705   <- duracao real do arquivo
//   usage.seconds   2                    <- o que a OpenAI COBRA (arredondado)
//
// O que vai para `audio_segundos` e o COBRADO, nao o real: a coluna existe para
// ratear custo, e ratear pelo real subestimaria sistematicamente — todo audio e
// arredondado para cima, e nota de voz curta e o caso comum. Com audios de ~2s,
// a diferenca chega perto de 10%.
//
// `duration` fica no diagnostico, para calibrar o proxy de bytes; a diferenca de
// arredondamento e irrelevante contra um corte de 3 minutos.
const bruto = String(resposta.text ?? '').trim();
const cobrado = Number(resposta.usage?.seconds);
const real = Number(resposta.duration);
// Fallback para o real se `usage` nao vier: melhor medir com o numero errado do
// que nao medir. Se isso acontecer, `_duracao_fonte` denuncia.
const duracao = Number.isFinite(cobrado) ? cobrado : real;

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
    // Diagnostico. `_duracao_fonte` denuncia se a OpenAI parar de mandar `usage`
    // e o rateio tiver caido no numero real — que subestima.
    _duracao_fonte: Number.isFinite(cobrado) ? 'usage.seconds' : 'duration',
    _duracao_real: Number.isFinite(real) ? real : null,
    // Guardado para calibrar o proxy: o corte por bytes so vale enquanto a
    // relacao bytes/segundo se mantiver. Com o par medido em execucao real, o
    // limite deixa de ser aritmetica de bitrate.
    _file_size: Number($('Extrair e Filtrar').first().json.anexo?.file_size) || 0
  }
}];
