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
  /**
   * 07/10: esta conta entrega no balcão? Ausente = SIM, que é o que toda conta
   * viva faz hoje — o default preserva o texto byte a byte para elas.
   *
   * Nasceu da conversa 51 do sendbox: o cliente pediu "Treinamento de NR 01" e
   * o Hércules perguntou se ele queria "retirar no local, pois só trabalhamos
   * com retirada". A estud.you vende curso on-line; não há balcão. A frase não
   * veio do prompt dela nem vazou de outro cliente — estava HARDCODED aqui,
   * entrando no prompt de todo tenant com perfil `vendas`. Era certa para o
   * Empório (loja física) e sem sentido para qualquer conta que venda algo
   * digital, inclusive as futuras.
   */
  retiradaFisica: boolean;
}

export const OFERTA_PADRAO: Oferta = { pagamentos: ['link'], entrega: 'nao', notaChatwoot: false, destinoDono: null, pedirNome: false, retirada: { endereco: null, mapaUrl: null }, retiradaFisica: true };

/** A mensagem de endereço que vai ao cliente; null quando a conta não cadastrou. */
export function mensagemDeRetirada(o: Oferta): string | null {
  // 07/10: sem balcão não há para onde mandar ninguém. A mensagem de endereço
  // (72) sai ao fechar, em mensagem própria — numa conta digital ela seria o
  // cliente recebendo um "📍 Retirada:" depois de comprar um curso on-line.
  if (!o.retiradaFisica) return null;
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
    // `!== false`, não `=== true`: a chave não existe em nenhuma conta de hoje,
    // e ausente tem de significar o comportamento de hoje.
    retiradaFisica: c['retirada_fisica'] !== false,
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
  // 07/10: o bloco de retirada/entrega só faz sentido em conta que tem balcão.
  // Ver `retiradaFisica` no tipo — era incondicional e virou pergunta sem
  // sentido para quem vende curso on-line.
  if (o.retiradaFisica) {
    linhas.push('- Só RETIRADA no local. Nunca pergunte endereço, nunca prometa entrega, nunca invente taxa.');
    if (o.entrega === 'atendente') {
      linhas.push('- Se o cliente quiser ENTREGA: monte o pedido normalmente (adicionar/ver) e, quando ele confirmar os itens, NÃO chame fechar — chame transferir_humano com o resumo "cliente quer entrega" + os itens e o total. Um atendente combina a entrega e o valor.');
    } else {
      linhas.push('- Se o cliente quiser ENTREGA: diga que por aqui só há retirada no local e pergunte se quer retirar. Não transfira por isso.');
    }
  } else {
    linhas.push('- Esta conta não tem balcão: nada aqui é retirado nem entregue por portador. Nunca pergunte se o cliente quer retirar ou receber, nunca peça endereço, nunca fale em buscar, loja, frete ou taxa, e nunca combine hora de retirada.');
  }
  if (o.pedirNome) {
    linhas.push(`- Antes de fechar, pergunte EM NOME DE QUEM fica o pedido${o.retiradaFisica ? ' (quem vai retirar)' : ''} e passe em nome_retirada. Sem o nome o fechamento é recusado.`);
  }
  // `&& o.retiradaFisica`: o painel recusa endereço sem balcão, mas uma config
  // incoerente (jsonb editado à mão, conta que desligou o balcão com o endereço
  // antigo gravado) não pode ressuscitar a linha — foi o que o teste pegou.
  if (o.retirada.endereco && o.retiradaFisica) {
    linhas.push('- O endereço de retirada é enviado ao cliente automaticamente, em mensagem própria, assim que o pedido fecha — não o repita nem invente outro.');
  }
  // 18/09: a foto vai junto com a resposta (uma mensagem só); a frase do
  // modelo é a legenda. Mora aqui, e não no wrapper fixo, porque o wrapper é
  // byte a byte o do n8n (teste:agente-servico §2).
  linhas.push('- Foto de produto (enviar_foto_produto): a foto vai JUNTO com a sua resposta, numa mensagem só — a sua frase vira a legenda. Depois de chamar a ferramenta, escreva só uma frase curta sobre o item; não diga "enviei a foto" à parte.');
  const soLink = o.pagamentos.length === 1 && o.pagamentos[0] === 'link';
  const soRetirada = o.pagamentos.length === 1 && o.pagamentos[0] === 'na_retirada';
  if (soLink) {
    linhas.push('- Pagamento: só por link (Pix/cartão), na hora. Ao fechar, use pagamento="link".');
  } else if (soRetirada) {
    linhas.push(o.retiradaFisica
      ? '- Pagamento: só NA RETIRADA. Ao fechar, use pagamento="na_retirada" e diga que ele paga quando buscar. Não gere link. NUNCA diga que está pago — quem confirma é a loja, no balcão.'
      : '- Pagamento: só DEPOIS, combinado com a equipe. Ao fechar, use pagamento="na_retirada" e diga que alguém do time acerta o pagamento com ele. Não gere link. NUNCA diga que está pago — quem confirma é a equipe.');
  } else {
    linhas.push(o.retiradaFisica
      ? '- Pagamento: o cliente escolhe entre "por link (Pix/cartão) agora" e "na retirada (paga quando buscar)". PERGUNTE antes de fechar e passe a escolha em pagamento="link" ou pagamento="na_retirada". Fechou na retirada: não gere link e nunca diga que está pago.'
      : '- Pagamento: o cliente escolhe entre "por link (Pix/cartão) agora" e "depois, combinado com a equipe". PERGUNTE antes de fechar e passe a escolha em pagamento="link" ou pagamento="na_retirada". Fechou para depois: não gere link e nunca diga que está pago.');
  }
  return linhas.join('\n') + '\n\n';
}
