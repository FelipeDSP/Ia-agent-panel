import 'server-only';

import { detectar, ordenar, type Achado } from './deteccoes';
import { contexto, instrucoes, separarPropostas } from './contexto';
import type { ModeloAssistente, UsoTokens } from './modelo';
import { lerPropostas, type Descartada, type Proposta } from './proposta';
import { montarRetrato } from './snapshot';

/**
 * UM TURNO do assistente do painel.
 *
 * O turno é SÓ LEITURA, e isso é a propriedade central deste arquivo: ele lê a
 * conta, conversa e devolve propostas. Não escreve nada em lugar nenhum — nem
 * o que o modelo propôs, nem a conversa. Quem escreve é `aplicarProposta`,
 * depois do cliente aprovar (método 2).
 *
 * `tests/assistente-conversa.mjs` mede isso com retrato de todas as tabelas com
 * `tenant_id` antes e depois, do mesmo jeito que o ensaio do agente — porque foi
 * medindo assim que apareceu a escrita que eu não tinha previsto lá.
 *
 * O TENANT VEM DE QUEM CHAMOU, que o resolveu do JWT (regra 1). Este arquivo
 * não tem como descobrir tenant sozinho e é de propósito.
 */

/** Teto da conversa que volta do navegador. Conversa longa é custo por turno. */
export const MAX_HISTORICO = 12;
const MAX_PERGUNTA = 2_000;

export type Resultado = {
  texto: string;
  propostas: Proposta[];
  descartadas: Descartada[];
  achados: Achado[];
  uso: UsoTokens;
  modelo: string;
  /** O que o retrato não conseguiu ler — vai à tela, não ao silêncio. */
  errosDeLeitura: string[];
};

type Supa = Parameters<typeof montarRetrato>[0];

export async function conversar(
  deps: { supabase: Supa; modelo: ModeloAssistente },
  p: {
    tenantId: string;
    pergunta: string;
    historico?: { papel: 'user' | 'assistant'; texto: string }[];
  },
): Promise<Resultado> {
  const pergunta = String(p.pergunta ?? '').trim().slice(0, MAX_PERGUNTA);
  if (!pergunta) throw new Error('pergunta vazia');

  const retrato = await montarRetrato(deps.supabase, p.tenantId);
  const achados = ordenar(detectar(retrato));

  // O histórico entra DEPOIS do contexto e antes da pergunta. Só as últimas
  // trocas: o contexto é relido a cada turno, então histórico velho só repete
  // informação que já está lá — em versão desatualizada, o que é pior.
  const historico = (p.historico ?? []).slice(-MAX_HISTORICO).map((m) => ({
    papel: m.papel === 'assistant' ? 'assistant' as const : 'user' as const,
    texto: String(m.texto ?? '').slice(0, MAX_PERGUNTA),
  }));

  const r = await deps.modelo.responder({
    instrucoes: instrucoes(),
    mensagens: [
      { papel: 'user', texto: contexto(retrato, achados) },
      ...historico,
      { papel: 'user', texto: pergunta },
    ],
  });

  const { texto, bruto } = separarPropostas(r.texto);
  const { propostas, descartadas } = lerPropostas(bruto);

  return {
    texto,
    propostas,
    descartadas,
    achados,
    uso: r.uso,
    modelo: r.modelo,
    errosDeLeitura: retrato.erros,
  };
}
