// ============================================================================
// PASSO 0 — ELE NAO FAZ NADA, DE PROPOSITO.
//
// ESTE ARQUIVO E A FONTE. O corpo dentro do JSON e injetado por
// `scripts/gerar-passo0.mjs`; editar o no pela UI do n8n perde a alteracao.
//
// ----------------------------------------------------------------------------
// A UNICA PERGUNTA QUE ELE RESPONDE
// ----------------------------------------------------------------------------
// O webhook do Chatwoot da conta 57 / caixa 282 (`estudyou-sendbox`) chega
// AQUI, UMA VEZ por mensagem, e o `emporio` (59 / 279) continua no principal.
//
// Nao ha Postgres, nao ha resposta ao cliente e nao ha AI. Se qualquer uma
// dessas coisas aparecer neste workflow, ele deixou de ser o passo 0.
//
// ----------------------------------------------------------------------------
// POR QUE ISSO VEM ANTES DE QUALQUER CODIGO DE PAGAMENTO
// ----------------------------------------------------------------------------
// Dois workflows inscritos no MESMO par (conta, caixa) geram execucao dupla
// para a mesma mensagem. A duplicidade nao aparece como erro em lugar nenhum —
// aparece como o cliente recebendo duas respostas, dois pedidos, ou duas
// cobrancas. Qualquer medicao feita antes disso estar provado mede outra coisa.
// ============================================================================
const b = $input.first().json.body ?? {};

const origem = {
  event: b.event ?? null,
  message_type: b.message_type ?? null,
  private: b.private ?? null,
  // A CAIXA NUNCA E CHUTADA: os dois caminhos que o `Extrair e Filtrar` do
  // principal usa, e `null` se nao houver. Valor de reserva faria o roteamento
  // resolver o tenant ERRADO em silencio — e a `api_n8n_tenant_por_chatwoot`
  // estoura `22023` em caixa nula justamente para isso nao acontecer.
  account_id: b.account?.id ?? null,
  inbox_id: b.conversation?.inbox_id ?? b.inbox?.id ?? null,
  conversation_id: b.conversation?.id ?? null,
  message_id: b.id ?? null,
  sender_type: b.sender?.type ?? null,
  // Carimbo desta execucao. DUAS execucoes para a MESMA `message_id` sao a
  // prova direta de que dois workflows estao inscritos no mesmo par.
  execucao_id: String($execution.id ?? ''),
  visto_em: new Date().toISOString(),
};

console.log('[passo0] ' + JSON.stringify(origem));

return [{ json: origem }];
