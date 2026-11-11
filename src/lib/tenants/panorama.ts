import { situacaoDaConta, tempoRelativo, type Situacao } from './situacao';

/**
 * O PANORAMA da lista de clientes: o que cada conta andou fazendo.
 *
 * ESTE ARQUIVO É PURO e não pode deixar de ser: `lista-clientes.tsx` é
 * componente de CLIENTE e importa daqui o tipo, a busca e a ordem. Um
 * componente de cliente arrasta o grafo inteiro de imports para o navegador,
 * então um `server-only` aqui derruba o build — foi o que aconteceu em 11/11,
 * exatamente como o `node:crypto` em `proposta.ts` tinha derrubado em outubro.
 * Quem fala com o banco mora em `panorama.server.ts`.
 *
 * ================== O QUE MUDOU E POR QUÊ ==================
 *
 * A lista mostrava "Documentos" e "Conversas" ACUMULADOS desde sempre — 669
 * contra 2 —, e isso não responde a pergunta que leva alguém até ela, que é
 * "como as contas estão". Em 19/10 o Felipe pediu exatamente esse retrato e
 * não havia tela: saiu de consultas SQL escritas à mão. Agora sai daqui.
 *
 * Saíram os acumulados; entraram atividade recente, falhas, custo do mês e
 * quando foi a última conversa. Inventário continua na ficha do cliente, que é
 * onde se pergunta "o que esta conta tem".
 *
 * ================== POR QUE UMA CONSULTA SÓ ==================
 *
 * A versão anterior fazia DUAS consultas POR CLIENTE (N+1) e o próprio
 * comentário avisava que, "quando passar de algumas dezenas, vira uma view
 * materializada". Em vez disso: uma varredura de `agente_turnos` na janela de
 * 60 dias, agregada em JavaScript. Medido em 11/11 — 1.890 turnos no total,
 * 272 nos últimos 7 dias —, e a janela limita o crescimento: a tabela inteira
 * nunca é lida.
 *
 * Quem não tem turno na janela não é erro nem lacuna: é a resposta "esta conta
 * não atende há mais de 60 dias", que é o que a coluna de situação vai dizer.
 */

/** Janela varrida. Fora dela a conta é "parada há muito", sem precisar do número exato. */
export const DIAS_JANELA = 60;
/** Janela do "andou atendendo": a semana é o que se compara de cabeça. */
export const DIAS_RECENTE = 7;

export type LinhaPanorama = {
  id: string;
  slug: string;
  nome: string;
  ativo: boolean;
  agenteAtivo: boolean;
  chatwootAccountId: number | null;
  chatwootInboxId: number | null;
  criadoEm: string;
  /** Conversas distintas atendidas nos últimos 7 dias. */
  conversas7d: number;
  turnos7d: number;
  falhas7d: number;
  ultimaAtividade: Date | null;
  ultimaAtividadeTexto: string;
  custoMesUsd: number | null;
  custoMesTexto: string;
  situacao: Situacao;
};

type Tenant = {
  id: string; slug: string; nome: string; ativo: boolean; agente_ativo: boolean;
  chatwoot_account_id: number | null; chatwoot_inbox_id: number | null; criado_em: string;
};

type Turno = { tenant_id: string; conversation_id: number | string; status: string; iniciado_em: string; acao: string };

/**
 * Ordem padrão: incidente primeiro, implantação pendente por último.
 *
 * A PRIMEIRA VERSÃO ERRAVA, e só apareceu ao abrir a tela: ela punha tudo que
 * não fosse "ok" na frente, então os quatro clientes que REALMENTE atendem
 * foram para o rodapé, abaixo de uma pilha de tenants de teste "não
 * conectado". A lista existe para achar o que está fora do lugar — e uma
 * conta que nunca foi ligada não está fora do lugar, está na fila.
 *
 * Alfabética também não serve: põe "Acqua" no topo todo dia, previsível e
 * inútil.
 */
const PESO: Record<Situacao['gravidade'], number> = { erro: 0, alerta: 1, ok: 2, neutro: 3 };

export function ordenarPanorama(linhas: LinhaPanorama[]): LinhaPanorama[] {
  return [...linhas].sort((a, b) => {
    // Falha de turno é o que mais urge: é cliente sem resposta agora.
    if ((b.falhas7d > 0 ? 1 : 0) !== (a.falhas7d > 0 ? 1 : 0)) return (b.falhas7d > 0 ? 1 : 0) - (a.falhas7d > 0 ? 1 : 0);
    if (PESO[a.situacao.gravidade] !== PESO[b.situacao.gravidade]) return PESO[a.situacao.gravidade] - PESO[b.situacao.gravidade];
    if (b.conversas7d !== a.conversas7d) return b.conversas7d - a.conversas7d;
    return a.nome.localeCompare(b.nome, 'pt-BR');
  });
}

/** Busca por nome ou slug, sem acento e sem caixa — como se digita com pressa. */
export function filtrarPanorama(linhas: LinhaPanorama[], termo: string): LinhaPanorama[] {
  const t = termo.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (!t) return linhas;
  const limpa = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  return linhas.filter((l) => limpa(l.nome).includes(t) || limpa(l.slug).includes(t));
}
