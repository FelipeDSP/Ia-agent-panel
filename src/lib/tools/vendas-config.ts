/**
 * Config da tool "vendas" (linha em tenant_tools) — migração 69.
 *
 * O `config` jsonb é lido por `vendas_oferta()` no banco (fechar_pedido,
 * notificar_venda, aviso_pedido). Não mude os nomes de chave sem mexer na
 * função junto:
 *
 *   { pagamentos: ('link'|'na_retirada')[],        // ausente = ['link']
 *     entrega: 'atendente'|'nao',                  // ausente = 'nao'
 *     eventos: Evento[],                           // ausente = todos
 *     notificacao: { canal: 'waha'|'chatwoot'|'nenhum', sessao?, destino?, nota_chatwoot? },
 *     pedir_nome: boolean,                          // 72: fechar exige o nome de quem retira
 *     retirada: { endereco?, mapa_url? },           // 72: o serviço manda ao cliente ao fechar
 *     horas_expirar_pagamento?: string }           // da migração 38; não é daqui
 *
 * CANAL (17/09, migração 70): o cliente só diz SE quer WhatsApp e PARA QUAL
 * número; por onde sai é derivado — com `sessao` da agência é `waha`, sem
 * sessão é `chatwoot` (a inbox do próprio agente, token da agência). Nenhuma
 * conta precisa de sessão para ser avisada; a sessão ficou como legado.
 *
 * Corte de responsabilidade, o mesmo da transferência:
 *  - Cliente (painel): pagamentos, entrega, eventos, notificar/destino,
 *    notificacao.nota_chatwoot.
 *  - Agência (super_admin): notificacao.sessao (opcional).
 * Cada lado preserva os campos do outro ao salvar (merge do jsonb).
 *
 * ENTREGA É GAVETA (decisão de 17/09): `modalidades` não existe aqui de
 * propósito — o agente só vende para retirada. O que o cliente decide sobre
 * entrega é só o que fazer quando pedem: passar a um atendente ou dizer que
 * não há.
 *
 * Puro (sem server-only): importado pelos componentes de formulário.
 */
import { formatarDestino } from './transferir-humano';

export const TOOL_VENDAS = 'vendas';

export const PAGAMENTOS = [
  { valor: 'link', rotulo: 'Por link (Pix/cartão), na hora', resumo: 'O agente gera o link e confirma o pagamento sozinho. Sem pagar em 24 h, o pedido expira.' },
  { valor: 'na_retirada', rotulo: 'Na retirada', resumo: 'O cliente paga quando buscar. Você marca como pago em Pedidos.' },
] as const;
export type Pagamento = (typeof PAGAMENTOS)[number]['valor'];

export const EVENTOS = [
  { valor: 'pedido_fechado', rotulo: 'Pedido fechado' },
  { valor: 'pagamento_confirmado', rotulo: 'Pagamento confirmado' },
  { valor: 'pedido_cancelado', rotulo: 'Pedido cancelado' },
] as const;
export type Evento = (typeof EVENTOS)[number]['valor'];

export type CanalAviso = 'waha' | 'chatwoot' | 'nenhum';

/** Por onde o WhatsApp sai: com sessão da agência, WAHA; sem, a inbox do agente. */
export function canalDerivado(notificar: boolean, sessao: string | undefined | null): CanalAviso {
  if (!notificar) return 'nenhum';
  return sessao ? 'waha' : 'chatwoot';
}

export type NotificacaoVendas = {
  canal: CanalAviso;
  sessao?: string;
  destino?: string;
  nota_chatwoot?: boolean;
};

export type Retirada = { endereco?: string; mapa_url?: string };

export type ConfigVendas = {
  pagamentos: Pagamento[];
  entrega: 'atendente' | 'nao';
  eventos: Evento[];
  notificacao: NotificacaoVendas;
  /** 72: o agente pergunta em nome de quem fica o pedido; o banco recusa fechar sem. Ausente = não. */
  pedir_nome: boolean;
  /** 72: endereço (e link do mapa) que o serviço manda ao cliente depois de fechar para retirada. */
  retirada: Retirada;
};

/** O que o banco assume quando a chave falta — a mesma leitura de `vendas_oferta()`. */
export const VENDAS_PADRAO: ConfigVendas = {
  pagamentos: ['link'],
  entrega: 'nao',
  eventos: EVENTOS.map((e) => e.valor),
  notificacao: { canal: 'nenhum' },
  pedir_nome: false,
  retirada: {},
};

export const MAX_ENDERECO = 300;

/** http(s) com host; qualquer outra coisa é recusada (o link vai ao cliente clicável). */
export function urlDeMapaValida(v: string): boolean {
  try { const u = new URL(v); return (u.protocol === 'https:' || u.protocol === 'http:') && u.hostname.length > 0; } catch { return false; }
}

const PAGAMENTOS_VALIDOS = new Set<string>(PAGAMENTOS.map((p) => p.valor));
const EVENTOS_VALIDOS = new Set<string>(EVENTOS.map((e) => e.valor));

/**
 * jsonb do banco → config com os defaults preenchidos. Chave desconhecida ou
 * valor inválido cai no default, nunca em erro: config errada não pode
 * derrubar a tela nem a venda.
 */
export function lerConfigVendas(bruto: unknown): ConfigVendas {
  const c = (bruto && typeof bruto === 'object' ? bruto : {}) as Record<string, unknown>;
  const pagamentos = Array.isArray(c['pagamentos'])
    ? (c['pagamentos'].filter((x): x is Pagamento => typeof x === 'string' && PAGAMENTOS_VALIDOS.has(x)))
    : [];
  const eventos = Array.isArray(c['eventos'])
    ? (c['eventos'].filter((x): x is Evento => typeof x === 'string' && EVENTOS_VALIDOS.has(x)))
    : [];
  const n = (c['notificacao'] && typeof c['notificacao'] === 'object' ? c['notificacao'] : {}) as Record<string, unknown>;
  const r = (c['retirada'] && typeof c['retirada'] === 'object' ? c['retirada'] : {}) as Record<string, unknown>;
  const endereco = typeof r['endereco'] === 'string' ? r['endereco'].trim().slice(0, MAX_ENDERECO) : '';
  const mapa = typeof r['mapa_url'] === 'string' && urlDeMapaValida(r['mapa_url'].trim()) ? r['mapa_url'].trim() : '';
  return {
    pagamentos: pagamentos.length > 0 ? [...new Set(pagamentos)] : VENDAS_PADRAO.pagamentos,
    entrega: c['entrega'] === 'atendente' ? 'atendente' : 'nao',
    eventos: eventos.length > 0 ? [...new Set(eventos)] : VENDAS_PADRAO.eventos,
    notificacao: {
      canal: n['canal'] === 'waha' || n['canal'] === 'chatwoot' ? n['canal'] : 'nenhum',
      ...(typeof n['sessao'] === 'string' && n['sessao'] ? { sessao: n['sessao'] } : {}),
      ...(typeof n['destino'] === 'string' && n['destino'] ? { destino: n['destino'] } : {}),
      ...(n['nota_chatwoot'] === true ? { nota_chatwoot: true } : {}),
    },
    pedir_nome: c['pedir_nome'] === true,
    retirada: { ...(endereco ? { endereco } : {}), ...(mapa ? { mapa_url: mapa } : {}) },
  };
}

type Resultado<T> = { ok: true; valor: T } | { ok: false; erros: Record<string, string> };

/**
 * Valida o que o CLIENTE edita. Não inclui `sessao` (é da agência); o server
 * mescla com o que já está gravado. `entrega = atendente` só é aceito quando
 * a transferência está contratada E ligada — sem ela o agente não teria para
 * quem passar, e a opção na tela nem aparece.
 */
export function validarVendasCliente(
  fd: FormData,
  { transferirDisponivel, linkDisponivel = true }: { transferirDisponivel: boolean; linkDisponivel?: boolean },
): Resultado<{
  pagamentos: Pagamento[];
  entrega: 'atendente' | 'nao';
  eventos: Evento[];
  notificar: boolean;
  destino?: string;
  nota_chatwoot: boolean;
  pedir_nome: boolean;
  retirada: Retirada;
}> {
  const erros: Record<string, string> = {};

  const pedir_nome = fd.get('pedir_nome') === 'on' || fd.get('pedir_nome') === 'true';
  const endereco = String(fd.get('endereco') ?? '').trim();
  if (endereco.length > MAX_ENDERECO) erros['endereco'] = `Endereço com no máximo ${MAX_ENDERECO} caracteres.`;
  const mapa_url = String(fd.get('mapa_url') ?? '').trim();
  if (mapa_url && !urlDeMapaValida(mapa_url)) erros['mapa_url'] = 'Cole o link completo do mapa (começa com https://).';
  if (mapa_url && !endereco) erros['endereco'] = 'Com o link do mapa, informe também o endereço em texto.';

  const pagamentos = PAGAMENTOS.map((p) => p.valor).filter((v) => fd.get(`pagamento_${v}`) === 'on');
  if (pagamentos.length === 0) erros['pagamentos'] = 'Marque ao menos uma forma de pagamento.';
  // 18/09: sem o módulo de pagamento (Asaas) contratado, "por link" não existe
  // no agente — aceitar aqui deixaria o pedido preso em "aguardando pagamento"
  // por 24 h sem ninguém cobrar. Esconder não é o mesmo que não poder.
  if (!linkDisponivel && pagamentos.includes('link')) erros['pagamentos'] = 'Pagamento por link exige o módulo de pagamento (Asaas), que esta conta não tem.';

  const entregaBruta = String(fd.get('entrega') ?? 'nao');
  let entrega: 'atendente' | 'nao' = entregaBruta === 'atendente' ? 'atendente' : 'nao';
  if (entrega === 'atendente' && !transferirDisponivel) {
    erros['entrega'] = 'Para passar pedidos de entrega a um atendente, a transferência para humano precisa estar ligada.';
    entrega = 'nao';
  }

  const eventos = EVENTOS.map((e) => e.valor).filter((v) => fd.get(`evento_${v}`) === 'on');
  const notificar = fd.get('notificar') === 'on' || fd.get('notificar') === 'true';
  const nota_chatwoot = fd.get('nota_chatwoot') === 'on' || fd.get('nota_chatwoot') === 'true';
  if ((notificar || nota_chatwoot) && eventos.length === 0) {
    erros['eventos'] = 'Marque ao menos um evento para ser avisado.';
  }

  const destinoBruto = String(fd.get('destino') ?? '').trim();
  let destino: string | undefined;
  if (destinoBruto) {
    const jid = formatarDestino(destinoBruto);
    if (!jid) {
      erros['destino'] = 'Informe o número com o código do país (ex.: 556993666645) ou cole o ID (…@c.us).';
    } else destino = jid;
  } else if (notificar) {
    erros['destino'] = 'Para avisar no WhatsApp, informe o número.';
  }

  if (Object.keys(erros).length > 0) return { ok: false, erros };
  return {
    ok: true,
    valor: {
      pagamentos,
      entrega,
      // lista vazia = todos (é como o banco lê a ausência); gravar vazio
      // seria "nenhum" na tela e "todos" no banco
      eventos: eventos.length > 0 ? eventos : VENDAS_PADRAO.eventos,
      notificar,
      destino,
      nota_chatwoot,
      pedir_nome,
      retirada: { ...(endereco ? { endereco } : {}), ...(mapa_url ? { mapa_url } : {}) },
    },
  };
}

/** Valida o que a AGÊNCIA edita: só a sessão do WAHA. */
export function validarVendasAgencia(fd: FormData): Resultado<{ sessao: string }> {
  const sessao = String(fd.get('sessao') ?? '').trim();
  if (sessao.length > 80) return { ok: false, erros: { sessao: 'Sessão muito longa.' } };
  return { ok: true, valor: { sessao } };
}

/** Rótulo curto para listas e detalhe do pedido. */
export function rotuloPagamentoModo(modo: string | null | undefined): string {
  if (modo === 'na_retirada') return 'Na retirada';
  if (modo === 'link') return 'Por link';
  return '—';
}

export function rotuloModalidade(m: string | null | undefined): string {
  if (m === 'retirada') return 'Retirada';
  if (m === 'entrega') return 'Entrega';
  return '—';
}
