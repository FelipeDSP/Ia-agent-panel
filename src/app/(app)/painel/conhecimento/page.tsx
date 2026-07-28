import { exigirTenantAdmin } from '@/lib/auth';
import { criarClienteServidor } from '@/lib/supabase/server';

import { listarStatusJobs, type JobStatus } from './acoes';
import { GestaoConhecimento, type Documento } from './componentes';

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

  const porOrigem = new Map<string, Documento>();
  for (const c of chunks ?? []) {
    const origem = (c.origem as string) ?? '(sem origem)';
    const meta = (c.metadata ?? {}) as Record<string, unknown>;
    const nome = (meta['arquivo'] as string) ?? (meta['fonte'] as string) ?? origem;
    const existente = porOrigem.get(origem);
    if (existente) {
      existente.chunks += 1;
    } else {
      porOrigem.set(origem, {
        origem,
        nome,
        chunks: 1,
        criadoEm: c.criado_em as string,
      });
    }
  }

  const documentos = Array.from(porOrigem.values());
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

      <GestaoConhecimento documentosIniciais={documentos} jobsIniciais={jobs} />
    </div>
  );
}
