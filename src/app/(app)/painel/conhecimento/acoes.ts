'use server';

import { randomUUID } from 'node:crypto';

import { revalidatePath } from 'next/cache';

import { exigirTenantAdmin } from '@/lib/auth';
import { invocarProcessamento } from '@/lib/ingestao';
import {
  MSG_JOB_MORTO,
  STATUS_EM_ANDAMENTO,
  filtroJobDispensavel,
  limiteJobMorto,
} from '@/lib/jobs-mortos';
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
    /*
     * MARCAR O JOB COMO 'erro' É O QUE TORNA A FALHA RECUPERÁVEL, e por isso o
     * erro DESTA escrita precisa ser olhado. `'pendente'` está no conjunto que
     * liga o polling (`componentes.tsx`, ATIVO) e o botão Reprocessar só
     * renderiza com `tipo === 'arquivo' && status === 'erro'`. Se este update
     * falhar em silêncio, o cliente fica com job eternamente “em andamento”,
     * tela consultando o servidor para sempre, e uma mensagem mandando clicar
     * num botão que não existe. O estado não é só irrecuperável — ele se
     * disfarça de progresso.
     *
     * NÃO É O MESMO CASO DE `excluirTenant`, e a diferença importa para quem
     * vier consertar por analogia. Lá havia duas escritas e a saída foi inverter
     * a ordem, para o resto pendurado ser o menos ruim. Aqui NÃO HÁ ORDEM A
     * INVERTER: quando este update roda, o arquivo já está no Storage e o job já
     * existe. A pergunta não é em que ordem escrever — é o que a tela diz
     * quando o estado ficou inconsistente e ninguém mais pode conserta-lo daqui.
     *
     * Por isso as duas mensagens são diferentes. “Tente reprocessar” só vale
     * quando o selo gravou e o botão vai estar lá; com o selo perdido, quem
     * resolve é a agência, e mandar o cliente clicar seria a mesma classe de
     * defeito que abriu esta série: instrução para fazer o impossível.
     */
    const { error: erroSelo } = await supabase
      .from('jobs_ingestao')
      .update({ status: 'erro', erro_msg: `Falha ao disparar processamento (HTTP ${r.status ?? '?'}).` })
      .eq('tenant_id', usuario.tenantId)
      .eq('id', job.id);

    if (erroSelo) {
      return {
        erro:
          `“${arquivo.name}” foi enviado, mas o processamento não iniciou e não consegui ` +
          'registrar a falha — ele vai continuar aparecendo como em andamento. ' +
          'Não há o que fazer por aqui: avise a agência para destravar.',
      };
    }

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
  // Caminho síncrono: a Server Action espera a Edge Function terminar. Texto
  // grande gera centenas de chunks (dezenas de chamadas à OpenAI) e estoura o
  // timeout. Acima deste limite, o usuário sobe como .txt — que segue o caminho
  // assíncrono (Storage + job + polling), sem prender a request.
  if (texto.length > 50_000) {
    return { erro: 'Texto muito longo para colar (máx. ~50 mil caracteres). Salve como .txt e use "Enviar arquivo".' };
  }

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

  // O caminho síncrono responde 200 mesmo quando o job não conclui (a função
  // devolve `ok: status === 'concluido'`). Só declaramos sucesso com o sinal
  // positivo `corpo.ok`; senão o cliente veria "adicionado" sem chunk gravado.
  if (!r.ok || corpo?.ok !== true || corpo?.job?.status === 'erro') {
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
  const usuario = await exigirTenantAdmin();
  const supabase = await criarClienteServidor();

  // RLS ja escopa por tenant; ainda assim filtramos explicito por ele (regra 6).
  const { data: job } = await supabase
    .from('jobs_ingestao')
    .select('id, tipo, status, arquivo_path')
    .eq('tenant_id', usuario.tenantId)
    .eq('id', jobId)
    .maybeSingle();

  if (!job) return { erro: 'Processamento não encontrado.' };
  if (job.tipo !== 'arquivo') return { erro: 'Só arquivos podem ser reprocessados.' };
  if (job.status === 'processando') return { erro: 'Já está processando.' };
  // A policy de jobs_ingestao é FOR ALL: o tenant pode INSERIR uma linha direto
  // pelo PostgREST com um arquivo_path apontando para a pasta de outro cliente.
  // A Edge Function baixa com service_role, que ignora o RLS de Storage — sem
  // esta checagem, disparar o reprocessamento devolveria o documento alheio
  // indexado como base deste tenant. A função também valida (é ela quem lê o
  // arquivo); aqui é a camada do painel, para o pedido nem sair daqui.
  if (!job.arquivo_path?.startsWith(`${usuario.tenantId}/`)) {
    return { erro: 'Processamento não encontrado.' };
  }

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

  const { data: afetados, error } = await supabase
    .from('kb_documentos')
    .update({ deletado_em: new Date().toISOString() })
    .eq('tenant_id', usuario.tenantId)
    .eq('origem', origem)
    .is('deletado_em', null)
    .select('id');

  if (error) return { erro: `Não foi possível excluir: ${error.message}` };
  // Sem linhas afetadas: origem inexistente, de outro tenant, ou já removida.
  // Não mentir "removido" quando nada mudou.
  if (!afetados || afetados.length === 0) {
    return { erro: 'Documento não encontrado (ou já removido).' };
  }

  revalidatePath('/painel/conhecimento');
  return { sucesso: 'Documento removido da base.' };
}

/**
 * Dispensa (remove) um job de ingestão que não vai mais a lugar nenhum. O job é
 * metadado de processamento efêmero (não é conteúdo do cliente), então é delete
 * físico, escopado por tenant + id + status. Guarda de rowcount como no
 * excluirDocumento: não mente "dispensado" se nada mudou.
 *
 * BUG PRÓPRIO, CONSERTADO AQUI — não é consequência da falta de expiração, e
 * está escrito separado de propósito: se um dia alguém remover
 * `marcarJobsMortos`, este conserto tem de continuar de pé sozinho.
 *
 * A versão anterior aceitava SÓ `status = 'erro'`. Um job travado em
 * `processando` (Edge Function morta no meio) não podia ser dispensado por
 * ninguém: a tela mostrava "processando" para sempre e o botão recusava. Saída
 * nenhuma, nem para o cliente nem para a agência.
 *
 * Agora aceita também `pendente` e `processando` — mas só depois do mesmo
 * limite que `marcarJobsMortos` usa, para não deixar o cliente matar um job que
 * está trabalhando. `concluido` segue fora: aquilo virou documento, e apagar o
 * registro esconderia o que existe na base.
 */
export async function dispensarJob(jobId: string): Promise<EstadoIngestao> {
  const usuario = await exigirTenantAdmin();
  const supabase = await criarClienteServidor();

  const limite = limiteJobMorto();

  // Duas condições em OR, porque são dois motivos diferentes de o job estar
  // acabado: falhou (erro, a qualquer momento) ou travou (em andamento, além do
  // limite). `or` do PostgREST, com o filtro de tenant e id fora dele —
  // esses valem sempre.
  const { data: afetados, error } = await supabase
    .from('jobs_ingestao')
    .delete()
    .eq('tenant_id', usuario.tenantId)
    .eq('id', jobId)
    .or(filtroJobDispensavel(limite))
    .select('id');

  if (error) return { erro: `Não foi possível dispensar: ${error.message}` };
  if (!afetados || afetados.length === 0) {
    return { erro: 'Processamento não encontrado (ou ainda está em andamento).' };
  }

  revalidatePath('/painel/conhecimento');
  return { sucesso: 'Processamento dispensado.' };
}

export type ChunkConteudo = { indice: number; texto: string };

/**
 * Conteúdo indexado de um documento: os chunks daquele `origem`, em ordem. É
 * exatamente o que o agente consulta — serve para o cliente conferir se subiu o
 * arquivo certo. Escopo por tenant explícito além do RLS (regra 6).
 */
export async function verConteudoDocumento(
  origem: string,
): Promise<{ chunks: ChunkConteudo[]; erro?: string }> {
  const usuario = await exigirTenantAdmin();
  const supabase = await criarClienteServidor();

  const { data, error } = await supabase
    .from('kb_documentos')
    .select('text, chunk_index')
    .eq('tenant_id', usuario.tenantId)
    .eq('origem', origem)
    .is('deletado_em', null)
    .order('chunk_index', { ascending: true });

  if (error) {
    return { chunks: [], erro: `Não foi possível carregar o conteúdo: ${error.message}` };
  }

  const chunks = (data ?? []).map((c) => ({
    indice: Number(c.chunk_index ?? 0),
    texto: String(c.text ?? ''),
  }));
  return { chunks };
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

/**
 * Marca como `erro` os jobs em andamento parados além do limite.
 *
 * EXPIRA NA LEITURA, sem agendador. O momento em que um job preso incomoda é
 * exatamente o momento em que alguém olha a tela — não às 3h da manhã. E o
 * polling já passa por aqui de 2,5 em 2,5 s enquanto houver job ativo, então o
 * gatilho já existe: não há função nova para alguém esquecer de chamar.
 *
 * O relógio é o do servidor do painel, não o do Postgres. A diferença entre os
 * dois é de segundos num limite de 15 minutos.
 *
 * Filtro explícito de tenant além da RLS, como toda escrita deste projeto.
 */
async function marcarJobsMortos(
  supabase: Awaited<ReturnType<typeof criarClienteServidor>>,
  tenantId: string,
): Promise<void> {
  const limite = limiteJobMorto();

  const { error } = await supabase
    .from('jobs_ingestao')
    .update({
      status: 'erro',
      erro_msg: MSG_JOB_MORTO,
      concluido_em: new Date().toISOString(),
    })
    .eq('tenant_id', tenantId)
    .in('status', [...STATUS_EM_ANDAMENTO])
    .lt('criado_em', limite);

  // Best-effort: se falhar, a listagem ainda vale. O job continua preso, que é
  // o estado de antes — nunca pior.
  if (error) console.error('marcarJobsMortos:', error.message);
}

/** Jobs recentes do tenant, para o polling de progresso. */
export async function listarStatusJobs(): Promise<JobStatus[]> {
  const usuario = await exigirTenantAdmin();
  const supabase = await criarClienteServidor();

  await marcarJobsMortos(supabase, usuario.tenantId);

  const { data } = await supabase
    .from('jobs_ingestao')
    .select('id, arquivo_nome, tipo, status, chunks_total, chunks_ok, erro_msg, criado_em')
    .eq('tenant_id', usuario.tenantId)
    .order('criado_em', { ascending: false })
    .limit(20);

  return (data ?? []) as JobStatus[];
}
