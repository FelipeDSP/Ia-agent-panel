import { Alert } from '@/components/ui/alert';
import { exigirMembro } from '@/lib/auth';
import { criarClienteServidor } from '@/lib/supabase/server';
import { chamadasDeAtendente, type PassoTransferencia } from '@/lib/conhecimento/lacunas';

import { AbasConhecimento } from '../abas';
import { ListaChamadas, ListaAprendido, type Aprendido } from './componentes';

/**
 * "Chamou atendente" — as vezes em que o agente precisou de gente.
 *
 * FASE 0 (30/09) do ciclo de aprendizado com revisão humana: mostra o que
 * aconteceu e oferece transformar em conteúdo da base. Sem tabela nova, sem
 * agrupamento e sem LLM — o porquê está em `src/lib/conhecimento/lacunas.ts`.
 *
 * ISOLAMENTO: a leitura é do cliente autenticado, e `agente_passos`/
 * `agente_turnos` têm policy `tenant_id = auth_tenant_id()`. Nada aqui filtra
 * por tenant à mão porque não há tenant à mão para filtrar — o JWT é a origem,
 * como manda a regra 1.
 */
export default async function PaginaChamadas() {
  await exigirMembro('editar_base');
  const supabase = await criarClienteServidor();

  // 60 dias: a retenção do trace é menor que isso, então o limite real é ela.
  const desde = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('agente_passos')
    .select('criado_em, entrada, saida, agente_turnos!inner(conversation_id)')
    .eq('nome', 'transferir_humano')
    .gte('criado_em', desde)
    .order('criado_em', { ascending: false })
    .limit(200);

  const chamadas = chamadasDeAtendente(data as PassoTransferencia[] | null);

  // O que o aprendizado automático guardou — e o que recusou, com o motivo.
  // Não é aprovação: já entrou. É auditoria, que é o que o cliente ganha em
  // troca de ter ligado um botão que escreve na base dele sem perguntar.
  const { data: aprendido } = await supabase.rpc('painel_aprendizado_recente', { p_limite: 30 });

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Base de conhecimento</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Quando o agente não resolve, ele chama um atendente e escreve um resumo do que o
          cliente queria. Cada linha abaixo é uma dessas vezes — e boa parte delas vira
          conteúdo que evita a próxima.
        </p>
      </header>

      <AbasConhecimento atual="chamadas" />

      {error ? (
        <Alert variant="destructive">Não foi possível carregar: {error.message}</Alert>
      ) : null}

      <ListaAprendido itens={(aprendido ?? []) as Aprendido[]} />

      <ListaChamadas chamadas={chamadas} />
    </div>
  );
}
