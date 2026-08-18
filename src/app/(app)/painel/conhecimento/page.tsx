import { exigirTenantAdmin } from '@/lib/auth';
import { Alert } from '@/components/ui/alert';
import { CRITERIO_NA_BASE, DICAS_BASE, TRECHOS_POR_BUSCA } from '@/lib/orientacao';
import { agruparDocumentos, type ChunkDaLista } from '@/lib/conhecimento/agrupar';
import { criarClienteServidor } from '@/lib/supabase/server';

import { listarStatusJobs, type JobStatus } from './acoes';
import { GestaoConhecimento } from './componentes';

export default async function PaginaConhecimento() {
  const usuario = await exigirTenantAdmin();
  const supabase = await criarClienteServidor();

  // Chunks ativos do tenant. Agrupamos por origem em JS para formar a lista de
  // "documentos" — a base nao tem tabela separada de documento, o documento e
  // o conjunto de chunks que compartilham origem.
  const { data: chunks } = await supabase
    .from('kb_documentos')
    .select('origem, metadata, criado_em')
    .eq('tenant_id', usuario.tenantId)
    .is('deletado_em', null)
    .order('criado_em', { ascending: false });

  const documentos = agruparDocumentos(chunks as ChunkDaLista[] | null);

  /*
   * O aviso de base pequena mede TRECHOS, não documentos.
   *
   * O pedido original falava em "menos de 3 documentos", e documento é a
   * unidade errada aqui: dois documentos de 40 trechos cada não têm o problema
   * nenhum, e receberiam um aviso alarmante e falso. Quem manda é o número que
   * a busca devolve — 5 por pergunta. Enquanto o total couber nesse limite, a
   * busca não escolhe nada: ela entrega a base inteira, para qualquer pergunta.
   */
  const totalTrechos = chunks?.length ?? 0;
  const baseCurta = totalTrechos > 0 && totalTrechos <= TRECHOS_POR_BUSCA;
  const jobs: JobStatus[] = await listarStatusJobs();

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Base de conhecimento</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Suba documentos ou cole texto. O agente passa a responder com esse conteúdo,
          sem intervenção da agência.
        </p>
        {/* A outra metade do critério — a recíproca da que está no editor de
            prompt. Fora do acordeão pelo mesmo motivo. */}
        <p className="mt-2 text-sm text-muted-foreground">{CRITERIO_NA_BASE}</p>
      </header>

      {/*
        O QUE O CLIENTE NÃO TEM COMO DEDUZIR.
        As outras lacunas do painel fazem ele decidir mal; esta acontece COM ele,
        sem sintoma na tela. A busca não tem piso de similaridade (ver
        docs/PENDENCIA-PISO-SIMILARIDADE.md): ela ordena por proximidade e corta
        no limite, então com base pequena o mesmo trecho volta para toda
        pergunta — e o agente o recebe rotulado como contexto relevante.
      */}
      {baseCurta ? (
        <Alert variant="warning">
          <strong>Sua base ainda é pequena — {totalTrechos} trecho{totalTrechos > 1 ? 's' : ''}.</strong>{' '}
          A cada pergunta o agente busca os {TRECHOS_POR_BUSCA} trechos mais parecidos com ela. Com
          uma base deste tamanho ele recebe <strong>todos os seus trechos, seja qual for a
          pergunta</strong> — quem perguntar sobre entrega pode receber o que você escreveu sobre
          endereço. Acrescente conteúdo até cobrir os assuntos que seus clientes mais perguntam:
          horário, pagamento, entrega e trocas.
        </Alert>
      ) : null}

      <details className="rounded-xl border border-border bg-muted/40 px-4 py-3 text-sm">
        <summary className="cursor-pointer font-medium">
          Como montar uma boa base de conhecimento
        </summary>
        <ul className="mt-3 flex list-disc flex-col gap-1.5 pl-5 text-muted-foreground">
          {DICAS_BASE.map((dica) => (
            <li key={dica}>{dica}</li>
          ))}
        </ul>
      </details>

      <GestaoConhecimento documentosIniciais={documentos} jobsIniciais={jobs} />
    </div>
  );
}
