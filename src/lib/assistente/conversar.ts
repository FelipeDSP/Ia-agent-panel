import 'server-only';

import { detectar, ordenar, type Achado } from './deteccoes';
import { contexto, instrucoes, instrucoesDeReescrita, separarPropostas } from './contexto';
import type { ModeloAssistente, UsoTokens } from './modelo';
import { hashPrompt, lerIntencoes, lerPropostas, type Descartada, type Proposta } from './proposta';
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
  /** A conversa foi cortada no teto de saída — a tela avisa em vez de calar. */
  truncado: boolean;
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
  const { intencoes, descartadas } = lerIntencoes(bruto);
  const uso = { ...r.uso };

  /*
   * A MATERIALIZAÇÃO. A conversa disse O QUE mudar; aqui a proposta ganha
   * corpo, e quem preenche o `baseHash` é o CÓDIGO — com o prompt que ele
   * acabou de ler do banco. O modelo não tem como errá-lo nem inventá-lo, e a
   * validação final continua sendo `lerPropostas`, a mesma que `aplicar` roda
   * do outro lado.
   *
   * Uma chamada por intenção de prompt (no máximo três, pelo teto das
   * instruções). Reescrita que volta vazia ou que quebra a guarda do marcador
   * vira descarte com motivo, nunca proposta silenciosamente ruim.
   */
  const brutas: unknown[] = [];
  for (const i of intencoes) {
    if (i.tipo === 'horario') {
      brutas.push({ tipo: 'horario', titulo: i.titulo, porque: i.porque, janelas: i.janelas });
      continue;
    }
    const rr = await deps.modelo.responder({
      instrucoes: instrucoesDeReescrita(),
      mensagens: [{
        papel: 'user',
        texto: `MUDANÇA A FAZER: ${i.mudanca}\n\nPROMPT ATUAL (${retrato.prompt.length} caracteres):\n\n${retrato.prompt}`,
      }],
    });
    uso.entrada += rr.uso.entrada;
    uso.saida += rr.uso.saida;
    const novo = rr.texto.trim();
    if (!novo) { descartadas.push({ tipo: 'prompt', motivo: 'a reescrita voltou vazia' }); continue; }
    if (rr.truncado) { descartadas.push({ tipo: 'prompt', motivo: 'a reescrita foi cortada no meio (prompt muito longo)' }); continue; }
    brutas.push({ tipo: 'prompt', titulo: i.titulo, porque: i.porque, texto: novo, baseHash: hashPrompt(retrato.prompt) });
  }

  // `promptAtual` liga a guarda do marcador: proposta que ACRESCENTA `{{...}}`
  // é descartada, com motivo visível na tela.
  const final = lerPropostas(brutas, { promptAtual: retrato.prompt });

  return {
    texto,
    propostas: final.propostas,
    descartadas: [...descartadas, ...final.descartadas],
    achados,
    uso,
    modelo: r.modelo,
    truncado: r.truncado === true,
    errosDeLeitura: retrato.erros,
  };
}
