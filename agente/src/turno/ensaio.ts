/**
 * ENSAIO — rodar o turno de verdade sem deixar rastro.
 *
 * O que ele responde é "o que o agente DIRIA", com o prompt real, a base real,
 * o catálogo real e o portão real. O que ele não faz é escrever: nada vai ao
 * Chatwoot, nada entra em `mensagens_log`, nada toca a memória nem a pausa da
 * conversa do cliente.
 *
 * O CHATWOOT MUDO É A DEFESA PRINCIPAL, e é por desenho e não por disciplina.
 * `executarTurno` manda ao Chatwoot em quatro lugares diferentes, e o quinto
 * que alguém acrescentar amanhã não vai lembrar do ensaio. Guardar cada chamada
 * seria uma lista para manter; trocar a dependência fecha a porta inteira, para
 * as quatro de hoje e para as que vierem. É a mesma injeção que os testes já
 * usam.
 *
 * O que ele TENTARIA enviar fica registrado, porque é informação: numa conta
 * com aviso ao dono, saber que o agente teria mandado uma nota privada explica
 * metade do comportamento.
 */
import type { Chatwoot } from '../chatwoot/enviar.ts';
import type { Db } from '../db.ts';
import { fnUma } from '../db.ts';
import { executarTurno, type Deps, type Ensaio } from './executar.ts';
import type { Tenant } from '../tenant/resolver.ts';

/** O que o agente teria mandado, se fosse de verdade. */
export interface EnvioSimulado { tipo: 'mensagem' | 'nota_privada' | 'numero' | 'atribuir_time'; conteudo: string }

/** Chatwoot que não fala com ninguém e anota o que teria falado. */
export function chatwootMudo(registro: EnvioSimulado[]): Chatwoot {
  return {
    async enviar(p) {
      registro.push({ tipo: p.privada ? 'nota_privada' : 'mensagem', conteudo: p.content });
      return { mensagemId: null };
    },
    async enviarParaNumero(p) {
      registro.push({ tipo: 'numero', conteudo: `${p.numero}: ${p.texto}` });
      return { conversationId: 0, mensagemId: null, contatoId: 0 };
    },
    temTokenDaAgencia: () => false,
    async atribuirTime(p) {
      registro.push({ tipo: 'atribuir_time', conteudo: `time ${p.teamId}` });
      return { time: null };
    },
  };
}

/**
 * A conversa do ensaio. NEGATIVA de propósito: `conversation_id` do Chatwoot é
 * sempre positivo, então um id negativo não colide com conversa de cliente
 * nenhuma — nem hoje nem quando a numeração do Chatwoot crescer. Um id "alto o
 * bastante" seria uma aposta contra o tempo.
 */
export const CONVERSA_DE_ENSAIO = -1;

export interface PedidoEnsaio {
  tenantId: string;
  /** O histórico da sessão de teste; vazio = primeira mensagem. */
  historico: { papel: 'cliente' | 'agente'; texto: string }[];
  pergunta: string;
}

export interface RespostaEnsaio {
  ok: boolean;
  resposta: string;
  turnoId: string | null;
  enviosSimulados: EnvioSimulado[];
  motivo?: string;
}

export async function ensaiar(
  deps: Omit<Deps, 'chatwoot'>,
  p: PedidoEnsaio,
): Promise<RespostaEnsaio> {
  const tenant = await fnUma<Tenant>(deps.db as Db, 'api_agente_tenant_por_id', [p.tenantId])
    .catch(() => undefined);
  if (!tenant) return { ok: false, resposta: '', turnoId: null, enviosSimulados: [], motivo: 'tenant_desconhecido' };

  const envios: EnvioSimulado[] = [];
  // A traducao mora aqui, na borda: fora fala `cliente`/`agente` (quem le e
  // gente), dentro fala `human`/`ai` (o que o modelo e a memoria usam).
  const ensaio: Ensaio = {
    historico: p.historico.map((m) => ({ papel: m.papel === 'cliente' ? 'human' as const : 'ai' as const, texto: m.texto })),
  };

  const r = await executarTurno(
    { ...deps, chatwoot: chatwootMudo(envios) } as Deps,
    {
      tenant,
      conversationId: CONVERSA_DE_ENSAIO,
      filaIds: [],
      mensagens: [{
        acao: 'processar',
        mensagem: p.pergunta,
        chatwoot_account_id: null,
        chatwoot_inbox_id: null,
      } as never],
      ensaio,
    },
  );

  return {
    ok: r.status === 'ok',
    resposta: r.resposta ?? '',
    turnoId: r.turnoId ?? null,
    enviosSimulados: envios,
    ...(r.status === 'ok' ? {} : { motivo: r.motivo ?? r.status }),
  };
}
