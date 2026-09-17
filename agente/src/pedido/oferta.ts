/**
 * O que a conta oferece em vendas (migração 69) — a leitura em TypeScript de
 * `tenant_tools.config` da tool `vendas`, com os MESMOS defaults de
 * `vendas_oferta()` no banco: ausente = só link; entrega = não; nota = não.
 * Quem decide de verdade é o banco (o `fechar` valida lá); aqui a leitura
 * serve para o prompt dizer ao modelo só o que existe e para o serviço saber
 * se a conta quer a nota privada.
 */
export type Pagamento = 'link' | 'na_retirada';

export interface Oferta {
  pagamentos: Pagamento[];
  entrega: 'atendente' | 'nao';
  notaChatwoot: boolean;
  /** `notificacao.destino` (dígitos), para reconhecer a conversa do próprio dono. */
  destinoDono: string | null;
}

export const OFERTA_PADRAO: Oferta = { pagamentos: ['link'], entrega: 'nao', notaChatwoot: false, destinoDono: null };

/** `55…@c.us` / `+55…` → dígitos; null quando não parece número. */
export function digitosDe(v: unknown): string | null {
  const d = String(v ?? '').replace(/@.*$/, '').replace(/\D/g, '');
  return d.length >= 10 ? d : null;
}

export function lerOferta(config: unknown): Oferta {
  const c = (config && typeof config === 'object' ? config : {}) as Record<string, unknown>;
  const lista = Array.isArray(c['pagamentos']) ? c['pagamentos'].filter((x): x is Pagamento => x === 'link' || x === 'na_retirada') : [];
  const n = (c['notificacao'] && typeof c['notificacao'] === 'object' ? c['notificacao'] : {}) as Record<string, unknown>;
  return {
    pagamentos: lista.length ? [...new Set(lista)] : OFERTA_PADRAO.pagamentos,
    entrega: c['entrega'] === 'atendente' ? 'atendente' : 'nao',
    notaChatwoot: n['nota_chatwoot'] === true,
    destinoDono: digitosDe(n['destino']),
  };
}

/**
 * A seção dinâmica do system message: só o que ESTA conta oferece. Entra
 * depois de `gerenciar_pedido` e antes das regras gerais, no perfil `vendas`.
 * O texto muda por tenant — o hash do prompt registra isso, como registra o
 * `system_prompt` do cliente.
 */
export function secaoOferta(o: Oferta): string {
  const linhas: string[] = ['## Como esta loja vende (regras desta conta)'];
  linhas.push('- Só RETIRADA no local. Nunca pergunte endereço, nunca prometa entrega, nunca invente taxa.');
  if (o.entrega === 'atendente') {
    linhas.push('- Se o cliente quiser ENTREGA: monte o pedido normalmente (adicionar/ver) e, quando ele confirmar os itens, NÃO chame fechar — chame transferir_humano com o resumo "cliente quer entrega" + os itens e o total. Um atendente combina a entrega e o valor.');
  } else {
    linhas.push('- Se o cliente quiser ENTREGA: diga que por aqui só há retirada no local e pergunte se quer retirar. Não transfira por isso.');
  }
  const soLink = o.pagamentos.length === 1 && o.pagamentos[0] === 'link';
  const soRetirada = o.pagamentos.length === 1 && o.pagamentos[0] === 'na_retirada';
  if (soLink) {
    linhas.push('- Pagamento: só por link (Pix/cartão), na hora. Ao fechar, use pagamento="link".');
  } else if (soRetirada) {
    linhas.push('- Pagamento: só NA RETIRADA. Ao fechar, use pagamento="na_retirada" e diga que ele paga quando buscar. Não gere link. NUNCA diga que está pago — quem confirma é a loja, no balcão.');
  } else {
    linhas.push('- Pagamento: o cliente escolhe entre "por link (Pix/cartão) agora" e "na retirada (paga quando buscar)". PERGUNTE antes de fechar e passe a escolha em pagamento="link" ou pagamento="na_retirada". Fechou na retirada: não gere link e nunca diga que está pago.');
  }
  return linhas.join('\n') + '\n\n';
}
