/**
 * Contratação no servidor: quem pode entrar numa superfície de tool.
 *
 * A PROPRIEDADE que este arquivo faz valer: toda superfície que uma tool traz —
 * item de menu, rota, seção de tela, indicador, Server Action — só existe para
 * quem contratou aquela tool.
 *
 * POR QUE ISTO NÃO É SÓ EXIBIÇÃO. Esconder o item de menu não impede digitar a
 * URL, e recusar a rota não impede chamar a Server Action, que é entrada própria
 * e não passa por página nenhuma. As três precisam da mesma checagem, e é por
 * isso que ela mora aqui em vez de em cada tela: uma verdade, três consumidores.
 *
 * É a mesma lição de três casos desta semana — `tool_ativa` que ninguém lia,
 * `config_tool` que ignorava `contratado`, e o Resolver Conversa sem guarda.
 * Regra correta que não é checada é regra que não existe.
 *
 * NÃO APAGA NADA. Descontratar esconde superfície; produtos, pedidos e fotos
 * continuam onde estão, e recontratar devolve tudo — `definirContratacao` só
 * vira o booleano.
 */

import 'server-only';

import { notFound } from 'next/navigation';

import { criarClienteServidor } from '@/lib/supabase/server';
import { toolDaRota } from '@/lib/tools/registro';

/**
 * Conjunto de tools contratadas pelo tenant.
 *
 * FALHA FECHA. Erro na query devolve conjunto VAZIO, não "assume contratado":
 * o menu perde as condicionais e as rotas de tool recusam. A escolha está
 * escrita junto de `menuDoPainel` — mostrar demais leva o cliente a clicar num
 * item que a rota recusa; mostrar de menos é sintoma que ele relata na hora.
 */
export async function toolsContratadas(tenantId: string): Promise<Set<string>> {
  const supabase = await criarClienteServidor();
  const { data, error } = await supabase
    .from('tenant_tools')
    .select('tool_nome')
    .eq('tenant_id', tenantId)
    .eq('contratado', true);

  if (error || !data) return new Set();
  return new Set(data.map((t) => t.tool_nome));
}

/** Se o tenant contratou a tool. Mesma regra de falha: erro = não contratado. */
export async function temToolContratada(tenantId: string, tool: string): Promise<boolean> {
  const supabase = await criarClienteServidor();
  const { data, error } = await supabase
    .from('tenant_tools')
    .select('tool_nome')
    .eq('tenant_id', tenantId)
    .eq('tool_nome', tool)
    .eq('contratado', true)
    .maybeSingle();

  return !error && Boolean(data);
}

/**
 * Guard de ROTA: 404 quando a tool dona da rota não está contratada.
 *
 * `notFound()` e não redirect: a rota realmente não existe para este cliente, e
 * um redirect com aviso ainda revelaria que a tela existe para outros.
 *
 * Use no `layout.tsx` do diretório da tool — ele cobre a subárvore inteira,
 * inclusive `[id]`, sem repetir a checagem em cada página.
 */
export async function exigirToolDaRota(tenantId: string, caminho: string): Promise<void> {
  const tool = toolDaRota(caminho);
  // Rota sem tool dona é sempre-visível: nada a exigir. O teste de superfície
  // garante que "sem dona" significa declarada em ROTAS_SEMPRE_VISIVEIS, e não
  // esquecida.
  if (!tool) return;
  if (!(await temToolContratada(tenantId, tool))) notFound();
}

/** Erro padrão das Server Actions de uma tool não contratada. */
export const ERRO_NAO_CONTRATADA =
  'Este módulo não está incluído no seu plano. Fale com a agência.';
