// ============================================================================
// RESPOSTA AO AGENTE — corpo do no Code do "Tool - Enviar Foto do Produto"
//
// ESTE ARQUIVO E A FONTE. O JSON do sub-workflow recebe uma copia injetada por
// scripts/gerar-tool-foto.mjs. Editar o no pela UI e perder a alteracao na
// proxima geracao — edite aqui.
//
// O QUE ELE FAZ. Traduz o veredicto de `api_n8n_enviar_foto` numa frase que o
// AGENTE le. Nao e mensagem para o cliente: e o retorno da ferramenta, e o
// modelo decide o que dizer a partir dele.
//
// POR QUE CADA MOTIVO TEM TEXTO PROPRIO. "Nao consegui" para tudo faria o modelo
// improvisar a explicacao — e improvisar explicacao e como ele acabou dizendo
// que registrou um pedido que nao existia. Cada recusa diz o que houve E o que
// fazer, para o modelo nao precisar inventar nenhum dos dois.
// ============================================================================

const v = $input.first().json ?? {};

// Caminho feliz: a foto ja foi entregue ao Chatwoot pelo no anterior.
if (v.enviada === true) {
  return [{
    json: {
      resultado:
        `Foto de "${v.produto_nome}" enviada ao cliente na conversa. ` +
        'Comente a foto em uma frase curta e siga o atendimento. ' +
        'NAO envie outra foto na sequencia; se ele quiser mais alguma, espere ele pedir.'
    }
  }];
}

// As recusas. `motivo` vem fechado do CHECK da migracao 35, entao este mapa
// cobre o dominio inteiro — e o fallback existe para o dia em que alguem
// acrescentar um motivo e esquecer daqui.
const RECUSAS = {
  nao_contratado:
    'Envio de foto nao esta disponivel para este cliente. Diga que nao consegue mandar imagem '
    + 'e siga descrevendo o item por texto.',

  produto_invalido:
    'Produto nao encontrado ou indisponivel. Confirme o item com o cliente e use consultar_catalogo '
    + 'para pegar o id certo antes de tentar de novo.',

  sem_foto:
    'Este item nao tem foto cadastrada. Diga que nao ha imagem DESSE item — sem prometer enviar '
    + 'depois — e descreva o produto por texto.',

  // A trava. O texto e deliberadamente instrutivo: sem ele, o modelo tende a
  // pedir desculpa e tentar de novo, que e exatamente o burst que a janela
  // existe para conter.
  janela:
    'Voce acabou de enviar uma foto nesta conversa. NAO tente de novo agora e nao se desculpe: '
    + 'termine de falar sobre a foto anterior e espere o cliente pedir a proxima.'
};

const motivo = String(v.motivo ?? '');
const texto = RECUSAS[motivo];

if (texto) {
  return [{ json: { resultado: texto } }];
}

// Fallback. Nunca deveria acontecer — mas dizer "nao consegui" e melhor do que
// devolver vazio, que faria o modelo preencher o silencio.
return [{
  json: {
    resultado:
      'Nao foi possivel enviar a foto agora. Siga o atendimento por texto e nao afirme que enviou.'
      + (motivo ? ` (motivo nao mapeado: ${motivo})` : '')
  }
}];
