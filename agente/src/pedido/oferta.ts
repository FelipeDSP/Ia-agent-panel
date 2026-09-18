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
  /** 72: o agente pergunta em nome de quem fica o pedido (o banco recusa fechar sem). */
  pedirNome: boolean;
  /** 72: endereço e link do mapa que o serviço manda ao cliente após fechar para retirada. */
  retirada: { endereco: string | null; mapaUrl: string | null };
}

export const OFERTA_PADRAO: Oferta = { pagamentos: ['link'], entrega: 'nao', notaChatwoot: false, destinoDono: null, pedirNome: false, retirada: { endereco: null, mapaUrl: null } };

/** A mensagem de endereço que vai ao cliente; null quando a conta não cadastrou. */
export function mensagemDeRetirada(o: Oferta): string | null {
  if (!o.retirada.endereco) return null;
  return `📍 *Retirada:* ${o.retirada.endereco}` + (o.retirada.mapaUrl ? `\n🗺️ ${o.retirada.mapaUrl}` : '');
}

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
    pedirNome: c['pedir_nome'] === true,
    retirada: (() => {
      const r = (c['retirada'] && typeof c['retirada'] === 'object' ? c['retirada'] : {}) as Record<string, unknown>;
      const endereco = typeof r['endereco'] === 'string' && r['endereco'].trim() ? r['endereco'].trim().slice(0, 300) : null;
      const mapaUrl = typeof r['mapa_url'] === 'string' && /^https?:\/\/\S+$/.test(r['mapa_url'].trim()) ? r['mapa_url'].trim() : null;
      return { endereco, mapaUrl };
    })(),
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
  // 18/09, conversa 39 do Empório: o cliente disse "são 20", o modelo AFIRMOU
  // "registrado 20" sem chamar ferramenta, o portão barrou três vezes e a venda
  // se perdeu. `adicionar` do mesmo item DEFINE a quantidade (não soma) — o
  // que faltava era o modelo saber disso.
  linhas.push('- Para MUDAR a quantidade de um item que já está no pedido ("são 20", "faz 5 em vez de 3"), chame gerenciar_pedido com acao=adicionar, o mesmo produto_id e a quantidade TOTAL nova — ela substitui a anterior. Nunca diga que alterou, anotou ou registrou sem o retorno da ferramenta mostrando a quantidade nova.');
  linhas.push('- Só RETIRADA no local. Nunca pergunte endereço, nunca prometa entrega, nunca invente taxa.');
  if (o.entrega === 'atendente') {
    linhas.push('- Se o cliente quiser ENTREGA: monte o pedido normalmente (adicionar/ver) e, quando ele confirmar os itens, NÃO chame fechar — chame transferir_humano com o resumo "cliente quer entrega" + os itens e o total. Um atendente combina a entrega e o valor.');
  } else {
    linhas.push('- Se o cliente quiser ENTREGA: diga que por aqui só há retirada no local e pergunte se quer retirar. Não transfira por isso.');
  }
  if (o.pedirNome) {
    linhas.push('- Antes de fechar, pergunte EM NOME DE QUEM fica o pedido (quem vai retirar) e passe em nome_retirada. Sem o nome o fechamento é recusado.');
  }
  if (o.retirada.endereco) {
    linhas.push('- O endereço de retirada é enviado ao cliente automaticamente, em mensagem própria, assim que o pedido fecha — não o repita nem invente outro.');
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
