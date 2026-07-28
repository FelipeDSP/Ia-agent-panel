'use server';

import { randomUUID } from 'node:crypto';

import { revalidatePath } from 'next/cache';

import { exigirTenantAdmin } from '@/lib/auth';
import { invocarProcessamento } from '@/lib/ingestao';
import { criarClienteServidor } from '@/lib/supabase/server';

export type EstadoIngestao = {
  erro?: string;
  sucesso?: string;
};

const BUCKET = 'kb-arquivos';
const LIMITE_BYTES = 10 * 1024 * 1024; // 10MB

// Extensao -> content type. A validacao principal e por extensao: o browser as
// vezes manda type vazio ou application/octet-stream para .txt.
const TIPOS: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  txt: 'text/plain',
};

function extensao(nome: string): string {
  const p = nome.toLowerCase().split('.');
  return p.length > 1 ? (p[p.length - 1] ?? '') : '';
}

/**
 * Upload de arquivo. Cria o job, sobe ao Storage no path {tenant}/{uuid}.ext
 * (RLS de Storage garante que so cai na pasta do proprio tenant) e dispara a
 * Edge Function. O processamento segue em background; o painel acompanha por
 * polling do job.
 *
 * tenantId vem SEMPRE de exigirTenantAdmin (JWT), nunca do formulario.
 */
export async function subirArquivo(
  _estado: EstadoIngestao,
  fd: FormData,
): Promise<EstadoIngestao> {
  const usuario = await exigirTenantAdmin();

  const arquivo = fd.get('arquivo');
  if (!(arquivo instanceof File) || arquivo.size === 0) {
    return { erro: 'Selecione um arquivo.' };
  }
  if (arquivo.size > LIMITE_BYTES) {
    return { erro: `Arquivo acima de 10MB (${(arquivo.size / 1024 / 1024).toFixed(1)}MB). Divida em partes menores.` };
  }

  const ext = extensao(arquivo.name);
  const contentType = TIPOS[ext];
  if (!contentType) {
    return { erro: 'Formato não suportado. Aceitos: PDF, DOCX, TXT.' };
  }

  const supabase = await criarClienteServidor();
  const path = `${usuario.tenantId}/${randomUUID()}.${ext}`;

  const { error: upErro } = await supabase.storage
    .from(BUCKET)
    .upload(path, arquivo, { contentType, upsert: false });
  if (upErro) {
    return { erro: `Falha no upload: ${upErro.message}` };
  }

  const { data: job, error: jobErro } = await supabase
    .from('jobs_ingestao')
    .insert({
      tenant_id: usuario.tenantId,
      arquivo_nome: arquivo.name,
      arquivo_path: path,
      tipo: 'arquivo',
      status: 'pendente',
      criado_por: usuario.id,
    })
    .select('id')
    .single();

  if (jobErro || !job) {
    // Job nao criou: remove o arquivo orfao do Storage.
    await supabase.storage.from(BUCKET).remove([path]);
    return { erro: `Não foi possível registrar o processamento: ${jobErro?.message ?? 'desconhecido'}` };
  }

  const r = await invocarProcessamento(job.id);
  if (!r.ok) {
    await supabase
      .from('jobs_ingestao')
      .update({ status: 'erro', erro_msg: `Falha ao disparar processamento (HTTP ${r.status ?? '?'}).` })
      .eq('id', job.id);
    return { erro: 'Arquivo enviado, mas o processamento não iniciou. Tente reprocessar.' };
  }

  revalidatePath('/painel/conhecimento');
  return { sucesso: `"${arquivo.name}" enviado. Processando…` };
}

/**
 * Texto colado. Caminho sincrono: sem Storage, sem espera de background. Cria o
 * job (tipo 'texto') e chama a funcao, que processa e responde ja.
 */
export async function ingerirTexto(
  _estado: EstadoIngestao,
  fd: FormData,
): Promise<EstadoIngestao> {
  const usuario = await exigirTenantAdmin();

  const titulo = String(fd.get('titulo') ?? '').trim();
  const texto = String(fd.get('texto') ?? '').trim();

  if (!titulo) return { erro: 'Dê um título para este conteúdo.' };
  if (texto.length < 20) return { erro: 'Texto muito curto para virar base de conhecimento.' };
  if (texto.length > 500_000) return { erro: 'Texto muito longo. Suba como arquivo.' };

  const supabase = await criarClienteServidor();

  const { data: job, error: jobErro } = await supabase
    .from('jobs_ingestao')
    .insert({
      tenant_id: usuario.tenantId,
      arquivo_nome: titulo,
      arquivo_path: null,
      tipo: 'texto',
      status: 'pendente',
      criado_por: usuario.id,
    })
    .select('id')
    .single();

  if (jobErro || !job) {
    return { erro: `Não foi possível registrar: ${jobErro?.message ?? 'desconhecido'}` };
  }

  const r = await invocarProcessamento(job.id, texto);
  const corpo = r.corpo as { ok?: boolean; job?: { status?: string; erro_msg?: string } } | null;

  if (!r.ok || corpo?.job?.status === 'erro') {
    return { erro: corpo?.job?.erro_msg ?? 'Falha ao processar o texto.' };
  }

  revalidatePath('/painel/conhecimento');
  return { sucesso: `"${titulo}" adicionado à base.` };
}

/**
 * Reprocessa um job existente (arquivo). Idempotente: o swap na Edge Function
 * apaga os chunks antigos daquele origem e insere os novos.
 */
export async function reprocessar(jobId: string): Promise<EstadoIngestao> {
  await exigirTenantAdmin();
  const supabase = await criarClienteServidor();

  // RLS ja escopa por tenant; conferimos que o job existe e e de arquivo.
  const { data: job } = await supabase
    .from('jobs_ingestao')
    .select('id, tipo, status')
    .eq('id', jobId)
    .maybeSingle();

  if (!job) return { erro: 'Processamento não encontrado.' };
  if (job.tipo !== 'arquivo') return { erro: 'Só arquivos podem ser reprocessados.' };
  if (job.status === 'processando') return { erro: 'Já está processando.' };

  const r = await invocarProcessamento(job.id);
  if (!r.ok) return { erro: 'Não foi possível reiniciar o processamento.' };

  revalidatePath('/painel/conhecimento');
  return { sucesso: 'Reprocessando…' };
}

/**
 * Remove um documento da base (soft delete dos chunks daquele origem).
 *
 * Aqui e o cliente apagando o documento de proposito — soft delete, como manda
 * o CLAUDE.md. Diferente do swap de reprocessamento, que faz delete fisico
 * porque esta apenas reindexando o mesmo arquivo.
 *
 * Filtro de tenant explicito alem do RLS (regra 6): as duas camadas.
 */
export async function excluirDocumento(origem: string): Promise<EstadoIngestao> {
  const usuario = await exigirTenantAdmin();
  const supabase = await criarClienteServidor();

  const { error } = await supabase
    .from('kb_documentos')
    .update({ deletado_em: new Date().toISOString() })
    .eq('tenant_id', usuario.tenantId)
    .eq('origem', origem)
    .is('deletado_em', null);

  if (error) return { erro: `Não foi possível excluir: ${error.message}` };

  revalidatePath('/painel/conhecimento');
  return { sucesso: 'Documento removido da base.' };
}

export type JobStatus = {
  id: string;
  arquivo_nome: string;
  tipo: string;
  status: string;
  chunks_total: number;
  chunks_ok: number;
  erro_msg: string | null;
  criado_em: string;
};

/** Jobs recentes do tenant, para o polling de progresso. */
export async function listarStatusJobs(): Promise<JobStatus[]> {
  await exigirTenantAdmin();
  const supabase = await criarClienteServidor();

  const { data } = await supabase
    .from('jobs_ingestao')
    .select('id, arquivo_nome, tipo, status, chunks_total, chunks_ok, erro_msg, criado_em')
    .order('criado_em', { ascending: false })
    .limit(20);

  return (data ?? []) as JobStatus[];
}
