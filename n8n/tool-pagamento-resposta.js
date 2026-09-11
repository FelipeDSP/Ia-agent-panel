// ============================================================================
// MONTA RESPOSTA — corpo do no Code que fecha o sub-workflow de gerar link.
//
// ESTE ARQUIVO E A FONTE. A copia dentro do JSON e injetada por
// `scripts/gerar-tool-pagamento.mjs`; editar o no pela UI perde a alteracao.
//
// ----------------------------------------------------------------------------
// O TEXTO QUE VOLTA AO MODELO E ESCRITO AQUI, EM CODIGO
// ----------------------------------------------------------------------------
// O modelo nao redige o valor, nao redige a URL, nao redige o prazo. Ele recebe
// uma frase pronta e a repassa. E o mesmo principio da narracao do portao: o
// que o codigo narra, o modelo nao precisa lembrar — e nao pode errar.
//
// A URL vai CRUA. Sem encurtador (parece golpe e e mais um servico no caminho do
// dinheiro) e sem markdown (WhatsApp nao interpreta link em texto de mensagem).
// A frase manda o modelo copiar como esta.
//
// DINHEIRO E INTEIRO EM CENTAVOS ate aqui. A formatacao em reais acontece so
// na montagem do texto (`brl`), e a conversao para decimal que o Asaas exige
// (`value: 5.00`) acontece so no no HTTP, na fronteira — nunca antes.
//
// ----------------------------------------------------------------------------
// A ENTRADA E UMA DE TRES
// ----------------------------------------------------------------------------
//   - a linha de `api_n8n_gerar_cobranca` com ok=false   -> o motivo vira frase
//   - a linha com ok=true e ja_existia=true               -> a URL que ja existia
//   - o item do `Registra Cobranca` depois do Asaas       -> a URL nova
//
// Quem me alimenta poe a linha da reserva em `reserva` e, se houve HTTP, a
// resposta do Asaas em `asaas`. Nada aqui chama o banco nem a rede.
// ============================================================================

const item = $input.first().json ?? {};
const reserva = item.reserva ?? item;
const asaas = item.asaas ?? null;
const falhaHttp = item.falha_http ?? null;

const brl = (centavos) =>
  'R$ ' + (Number(centavos ?? 0) / 100).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');

const horaBrasilia = (iso) => {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  // Brasilia = UTC-3, sem horario de verao desde 2019.
  const b = new Date(d.getTime() - 3 * 3600 * 1000);
  return `${String(b.getUTCHours()).padStart(2, '0')}:${String(b.getUTCMinutes()).padStart(2, '0')}`;
};

// O aviso que vai em TODA resposta positiva. E a unica linha desta ferramenta
// que fala do futuro, e ela fala para o modelo NAO afirmar.
const NUNCA_CONFIRME =
  'NAO afirme que o pagamento foi feito ou confirmado: o sistema avisa quando cair.';

let resultado;

if (reserva.ok !== true) {
  const motivo = String(reserva.motivo ?? 'desconhecido');
  const textos = {
    tool_inativa:
      'Pagamento por link nao esta disponivel para este atendimento. Ofereca as formas de pagamento '
      + 'de sempre ou transfira para um atendente.',
    sem_credencial:
      'Pagamento por link nao esta configurado. Transfira para um atendente para combinar o pagamento.',
    sem_pedido_fechado:
      'NAO HA PEDIDO FECHADO nesta conversa. Feche o pedido primeiro (gerenciar_pedido acao=fechar) '
      + 'e so entao gere o link.',
    ja_pago:
      `O pedido nº ${reserva.pedido_numero ?? '?'} JA ESTA PAGO. Nao gere link de novo; se o cliente `
      + 'quer comprar mais, e pedido novo.',
    total_zero:
      'O pedido fechado esta com total zero — nao ha o que cobrar. Confira os itens com o cliente.',
    abaixo_do_minimo:
      `O pedido nº ${reserva.pedido_numero ?? '?'} (${brl(reserva.valor_centavos)}) esta ABAIXO DO `
      + `MINIMO para pagamento por link, que e ${brl(reserva.minimo_centavos)}: faltam `
      + `${brl(reserva.faltam_centavos)}. Sugira ao cliente completar o pedido com pelo menos esse `
      + 'valor e gere o link depois. Se ele nao quiser completar, transfira para um atendente para '
      + 'combinar o pagamento de outro jeito. Nao invente desconto nem arredonde.',
  };
  resultado = textos[motivo]
    ?? `Nao foi possivel gerar o link (${motivo}). Transfira para um atendente.`;
} else if (falhaHttp) {
  // O Asaas recusou ou nao respondeu. O modelo NAO recebe o erro cru: recebe a
  // instrucao de nao inventar link e de transferir.
  resultado =
    'Nao consegui gerar o link de pagamento agora. NAO invente um link. Diga ao cliente que vai '
    + 'passar o pagamento para um atendente e transfira.';
} else {
  const url = String(asaas?.url ?? reserva.url ?? '').trim();
  if (!url) {
    resultado =
      'Nao consegui gerar o link de pagamento agora. NAO invente um link. Transfira para um atendente.';
  } else {
    const ate = horaBrasilia(reserva.expira_em);
    resultado =
      `Link de pagamento do pedido nº ${reserva.pedido_numero ?? '?'} — ${brl(reserva.valor_centavos)}`
      + (reserva.ja_existia ? ' (o mesmo link ja gerado antes)' : '')
      + `:\n${url}\n`
      + 'Mande ao cliente EXATAMENTE essa URL, sozinha numa linha, sem encurtar e sem texto clicavel.'
      + (ate ? ` O link vale ate as ${ate} de hoje (horario de Brasilia).` : '')
      + ` ${NUNCA_CONFIRME}`;
  }
}

return [{ json: { resultado } }];
