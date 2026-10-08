import 'server-only';

import { lerHorarioAgente } from '@/lib/tenants/horario-agente';
import { lerConfigVendas } from '@/lib/tools/vendas-config';

import { chaveDeOrigem, type RetratoConta } from './deteccoes';

/**
 * O retrato de uma conta: tudo o que o assistente precisa saber antes de
 * abrir a boca.
 *
 * Lê pelo CLIENTE DO USUÁRIO, não por `service_role`. Isso é o que faz a
 * mesma função servir ao dono da conta e à agência sem ramificar: a RLS
 * decide o que cada um alcança, e um `tenantId` de outro cliente devolve
 * vazio em vez de vazar. A regra 1 vale aqui como em qualquer lugar — o id
 * vem de quem chamou, que o resolveu do JWT, nunca do request.
 *
 * Toda consulta é escopada por `tenant_id` explícito ALÉM da RLS. É a regra 6:
 * a RLS é a rede, não a primeira linha.
 *
 * Consulta que falha não derruba o retrato — devolve a parte vazia. O
 * assistente precisa conseguir dizer "não consegui ler seu catálogo" em vez de
 * a tela inteira cair; e uma tabela que ainda não existe num ambiente (a
 * ordem dos deploys) não pode ser o fim da conversa.
 */

type Supa = {
  from: (t: string) => {
    select: (c: string, o?: unknown) => any;
  };
};

/** Quantos dias de respostas barradas entram no retrato. */
export const DIAS_BARRADAS = 7;

export async function montarRetrato(
  supabase: Supa,
  tenantId: string,
): Promise<RetratoConta & { nome: string | null; erros: string[] }> {
  const erros: string[] = [];
  const tentar = async <T>(nome: string, f: () => Promise<T>, vazio: T): Promise<T> => {
    try { return await f(); } catch (e) { erros.push(`${nome}: ${e instanceof Error ? e.message : String(e)}`); return vazio; }
  };

  const tenant = await tentar('conta', async () => {
    const { data, error } = await supabase.from('tenants')
      .select('nome, system_prompt, horario_agente').eq('id', tenantId).maybeSingle();
    if (error) throw new Error(error.message);
    return data as { nome: string | null; system_prompt: string | null; horario_agente: unknown } | null;
  }, null);

  const tools = await tentar('módulos', async () => {
    const { data, error } = await supabase.from('tenant_tools')
      .select('tool_nome, contratado, ativo, config').eq('tenant_id', tenantId);
    if (error) throw new Error(error.message);
    return (data ?? []) as { tool_nome: string; contratado: boolean; ativo: boolean; config: unknown }[];
  }, []);

  const produtos = await tentar('catálogo', async () => {
    const { data, error } = await supabase.from('produtos')
      .select('nome, preco_centavos, disponivel').eq('tenant_id', tenantId).is('deletado_em', null);
    if (error) throw new Error(error.message);
    return (data ?? []) as { nome: string; preco_centavos: number; disponivel: boolean }[];
  }, []);

  /*
   * A BASE: o job diz o que processou, a tabela diz o que existe. São duas
   * perguntas, e a diferença entre elas é o defeito — no Empório um documento
   * tem job `concluido` com 80 trechos e ZERO linhas. A tela de Conhecimento
   * lista jobs, então ela mostra o documento como presente e o agente nunca o
   * encontra: silencioso dos dois lados.
   *
   * O ELO DEPENDE DO TIPO, e isto custou um susto (08/10). A primeira versão
   * cruzava só por `'texto:' || job.id` e acusou 16 de 22 documentos como
   * sumidos — incluindo os 13 da estud.you. Era falso: para `tipo = 'arquivo'`
   * a `origem` é o CAMINHO NO STORAGE (`<tenant_id>/<uuid>.txt`), que é o
   * `arquivo_path` do job; só `tipo = 'texto'` usa o prefixo.
   *
   * Vale como regra, não como remendo: detector que erra para MAIS é pior que
   * detector nenhum. Um falso positivo numa tela de diagnóstico manda o
   * cliente reenviar treze documentos que já estavam lá.
   *
   * Lido em duas consultas e cruzado aqui, porque PostgREST não faz esse join
   * e um RPC novo seria migração por nada.
   */
  const documentos = await tentar('base de conhecimento', async () => {
    const { data: jobs, error: e1 } = await supabase.from('jobs_ingestao')
      .select('id, arquivo_nome, arquivo_path, tipo, status, chunks_ok').eq('tenant_id', tenantId);
    if (e1) throw new Error(e1.message);
    const { data: chunks, error: e2 } = await supabase.from('kb_documentos')
      .select('origem').eq('tenant_id', tenantId).is('deletado_em', null);
    if (e2) throw new Error(e2.message);
    const porOrigem = new Map<string, number>();
    for (const c of (chunks ?? []) as { origem: string }[]) {
      porOrigem.set(c.origem, (porOrigem.get(c.origem) ?? 0) + 1);
    }
    type Job = { id: string; arquivo_nome: string; arquivo_path: string | null; tipo: string; status: string; chunks_ok: number | null };
    return ((jobs ?? []) as Job[]).map((j) => ({
      nome: j.arquivo_nome,
      status: j.status,
      chunksJob: j.chunks_ok ?? 0,
      chunksTabela: porOrigem.get(chaveDeOrigem(j)) ?? 0,
    }));
  }, []);

  const barradas = await tentar('conversas', async () => {
    const desde = new Date(Date.now() - DIAS_BARRADAS * 86_400_000).toISOString();
    const { data, error } = await supabase.from('mensagens_log')
      .select('conversation_id, portao')
      .eq('tenant_id', tenantId)
      .gte('criado_em', desde)
      .not('portao', 'is', null)
      .limit(200);
    if (error) throw new Error(error.message);
    return ((data ?? []) as { conversation_id: number; portao: Record<string, unknown> | null }[])
      .filter((m) => String(m.portao?.['veredito'] ?? '').startsWith('barrado'))
      .map((m) => ({
        conversationId: m.conversation_id,
        veredito: String(m.portao?.['veredito'] ?? ''),
        bruto: typeof m.portao?.['bruto'] === 'string' ? (m.portao['bruto'] as string) : null,
      }));
  }, []);

  const vendas = tools.find((t) => t.tool_nome === 'vendas' && t.contratado && t.ativo);
  const cfg = vendas ? lerConfigVendas(vendas.config) : null;

  return {
    nome: tenant?.nome ?? null,
    prompt: tenant?.system_prompt ?? '',
    horario: (() => {
      const h = lerHorarioAgente(tenant?.horario_agente ?? null);
      return h ? { janelas: h.janelas } : null;
    })(),
    toolsAtivas: tools.filter((t) => t.contratado && t.ativo).map((t) => t.tool_nome).sort(),
    vendas: cfg ? { pagamentos: cfg.pagamentos, retirada_fisica: cfg.retirada_fisica } : null,
    produtos,
    documentos,
    barradas,
    erros,
  };
}
