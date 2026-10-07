/**
 * `Estado do Pedido` + `Aplica Portao`, em código — o portão é o MESMO
 * `n8n/aplica-portao.js` (16 KB, quatro testes), rodado como o n8n roda:
 * `$input` = a linha de `api_n8n_estado_pedido`, `$('Estima Tokens')` = o que
 * o modelo escreveu e os componentes já montados.
 *
 * O portão NÃO muda com a migração (DESENHO §0). O que muda é que aqui o
 * `estado` é `select *` da função — as colunas que o portão lê vêm todas,
 * sem a lista derivada que o injetor precisava manter no n8n.
 */
import { fnUma, type Db } from '../db.ts';
import { corpoRegra, rodarRegra } from '../regras-js.ts';

/**
 * As tools que, rodando num turno, podem ter mexido no PEDIDO.
 *
 * A lista sai do catalogo, nao da memoria. Em 07/10 as funcoes que escrevem em
 * `public.pedidos` eram: `api_n8n_adicionar_item`, `api_n8n_fechar_pedido`,
 * `api_n8n_cancelar_pedido`, `api_n8n_notificar_venda`,
 * `api_n8n_confirmar_notificacao`, `api_agente_aviso_pedido` e
 * `api_agente_confirmar_aviso` — TODAS alcancadas so por `gerenciar_pedido` (as
 * quatro ultimas sao o aviso ao dono, que roda dentro dela). As outras tres —
 * `api_n8n_pagamento_webhook`, `painel_marcar_pedido` e
 * `expirar_pedidos_vencidos` — nao acontecem dentro de turno nenhum.
 *
 * `teste:portao-escrita-do-turno` re-roda essa consulta e reprova se aparecer
 * um caminho novo: tool nova que escreva em pedido entra pela porta da frente.
 */
export const TOOLS_QUE_ESCREVEM_PEDIDO = ['gerenciar_pedido'];

export interface SaidaPortao {
  output: string;
  componentes: Record<string, unknown>;
  portao: Record<string, unknown>;
  transferir: boolean;
  notaPrivada: string | null;
  veredito: string;
}

export async function aplicarPortao(p: {
  db: Db; regrasDir: string; tenantId: string; conversationId: number; perfil: string;
  textoModelo: string; componentes: Record<string, unknown>;
  /** Os nomes das tools que rodaram NESTE turno. */
  toolsDoTurno?: string[];
}): Promise<SaidaPortao> {
  const estado = await fnUma<Record<string, unknown>>(p.db, 'api_n8n_estado_pedido', [p.tenantId, p.conversationId, p.perfil]);
  if (!estado) throw new Error('api_n8n_estado_pedido devolveu vazio');

  /*
   * "ESCREVEU NESTE TURNO" PRECISA DE QUEM, NÃO SÓ DE QUANDO (07/10/2026).
   *
   * A função infere isso por TEMPO: a linha do pedido mudou depois da última
   * saída, dentro de um teto de 5 min. A inferência nasceu quando só o AGENTE
   * escrevia em pedido — o próprio comentário dela diz isso. Desde a migração
   * 69 o painel também escreve, e desde a 83 escreve muito mais: "Separar" e
   * "Pagou e levou" são o trabalho de quem prepara os pedidos.
   *
   * Medido no sendbox, conversa 51:
   *   12:18:48–12:18:54  quatro cliques no painel (separar/pago/entregue)
   *   12:20:53           o cliente escreveu "oi"
   *   -> o portão leu `escreveu_neste_turno = true` e GRUDOU o resumo do
   *      pedido numa saudação. `bloco_anexado: true` no registro.
   *
   * Não é a janela que está errada — é a pergunta. O serviço SABE quais tools
   * rodaram, porque é ele que as executa. A janela vira condição necessária, e
   * a tool rodando é a outra: as duas, ou nada mudou por obra deste turno.
   *
   * ESTREITAR É SEMPRE SEGURO AQUI. `escreveu_neste_turno` aparece em dois
   * lugares do portão: na regra 1 (`afirmouForaDoPagamento && !escreveu`), onde
   * false faz BARRAR mais — a direção da defesa contra fabricação —, e no
   * `anexaBloco`, que é o defeito. Nunca afrouxa nada.
   */
  const escreveuPelaJanela = estado['escreveu_neste_turno'] === true;
  const rodouToolDePedido = (p.toolsDoTurno ?? []).some((t) => TOOLS_QUE_ESCREVEM_PEDIDO.includes(t));
  const estreitou = escreveuPelaJanela && !rodouToolDePedido;
  if (estreitou) estado['escreveu_neste_turno'] = false;

  const saida = rodarRegra(corpoRegra(p.regrasDir, 'aplica-portao.js'), { json: estado }, {
    'Estima Tokens': { output: p.textoModelo, componentes_json: JSON.stringify(p.componentes) },
  });
  let componentes: Record<string, unknown> = {};
  try { componentes = JSON.parse(String(saida.componentes_json ?? '{}')) as Record<string, unknown>; } catch { componentes = {}; }
  const portao = (componentes.portao ?? saida._portao ?? {}) as Record<string, unknown>;
  // Fica no trace: sem isto, "por que o bloco não veio?" não teria resposta.
  if (estreitou) portao['escrita_do_painel_ignorada'] = true;
  return {
    output: String(saida.output ?? ''),
    componentes,
    portao,
    transferir: saida._portao_transferir === true,
    notaPrivada: typeof saida._portao_nota_privada === 'string' ? saida._portao_nota_privada : null,
    veredito: String(portao.veredito ?? 'desconhecido'),
  };
}
