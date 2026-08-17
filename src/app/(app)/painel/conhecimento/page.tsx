import { exigirTenantAdmin } from '@/lib/auth';
import { DICAS_BASE } from '@/lib/orientacao';
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
  const jobs: JobStatus[] = await listarStatusJobs();

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Base de conhecimento</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Suba documentos ou cole texto. O agente passa a responder com esse conteúdo,
          sem intervenção da agência.
        </p>
      </header>

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
