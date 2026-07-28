'use client';

import { FileText, RefreshCw, Trash2, Upload } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useRef, useState, useTransition } from 'react';

import {
  excluirDocumento,
  ingerirTexto,
  listarStatusJobs,
  reprocessar,
  subirArquivo,
  type EstadoIngestao,
  type JobStatus,
} from './acoes';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SubmitButton } from '@/components/ui/submit-button';
import { Textarea } from '@/components/ui/textarea';

export type Documento = {
  origem: string;
  nome: string;
  chunks: number;
  criadoEm: string;
};

const ATIVO = new Set(['pendente', 'processando']);

function dataCurta(iso: string): string {
  try {
    return new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

function StatusBadge({ status }: { status: string }) {
  if (status === 'concluido') return <Badge variant="success">concluído</Badge>;
  if (status === 'erro') return <Badge variant="warning">erro</Badge>;
  if (status === 'processando') return <Badge>processando</Badge>;
  return <Badge variant="secondary">na fila</Badge>;
}

export function GestaoConhecimento({
  documentosIniciais,
  jobsIniciais,
}: {
  documentosIniciais: Documento[];
  jobsIniciais: JobStatus[];
}) {
  const router = useRouter();
  const [jobs, setJobs] = useState<JobStatus[]>(jobsIniciais);
  const [pendente, iniciarTransicao] = useTransition();
  const [feedback, setFeedback] = useState<EstadoIngestao>({});

  const [estadoArquivo, acaoArquivo] = useActionState<EstadoIngestao, FormData>(subirArquivo, {});
  const [estadoTexto, acaoTexto] = useActionState<EstadoIngestao, FormData>(ingerirTexto, {});

  const formArquivoRef = useRef<HTMLFormElement>(null);
  const formTextoRef = useRef<HTMLFormElement>(null);

  const temAtivo = jobs.some((j) => ATIVO.has(j.status));

  // Polling do progresso enquanto houver job na fila ou processando. Ao terminar
  // um job, atualiza a lista de documentos (router.refresh re-roda o Server
  // Component da pagina).
  useEffect(() => {
    if (!temAtivo) return;
    let vivo = true;
    const timer = setInterval(async () => {
      const atuais = await listarStatusJobs();
      if (!vivo) return;
      setJobs((anteriores) => {
        const aindaAtivo = atuais.some((j) => ATIVO.has(j.status));
        const eraAtivo = anteriores.some((j) => ATIVO.has(j.status));
        if (eraAtivo && !aindaAtivo) router.refresh();
        return atuais;
      });
    }, 2500);
    return () => {
      vivo = false;
      clearInterval(timer);
    };
  }, [temAtivo, router]);

  // Depois de enviar, limpa o formulario e reidrata os jobs para o polling pegar.
  useEffect(() => {
    if (estadoArquivo.sucesso) {
      formArquivoRef.current?.reset();
      listarStatusJobs().then(setJobs);
    }
  }, [estadoArquivo]);

  useEffect(() => {
    if (estadoTexto.sucesso) {
      formTextoRef.current?.reset();
      listarStatusJobs().then(setJobs);
      router.refresh();
    }
  }, [estadoTexto, router]);

  const aoReprocessar = (jobId: string) =>
    iniciarTransicao(async () => {
      setFeedback(await reprocessar(jobId));
      setJobs(await listarStatusJobs());
    });

  const aoExcluir = (origem: string, nome: string) =>
    iniciarTransicao(async () => {
      setFeedback(await excluirDocumento(origem));
      router.refresh();
      void nome;
    });

  return (
    <div className="flex flex-col gap-6">
      {feedback.erro ? <Alert variant="destructive">{feedback.erro}</Alert> : null}
      {feedback.sucesso ? <Alert variant="success">{feedback.sucesso}</Alert> : null}

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Upload de arquivo */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Upload className="h-4 w-4" aria-hidden />
              Enviar arquivo
            </CardTitle>
            <CardDescription>PDF, DOCX ou TXT, até 10MB. PDF precisa ter texto selecionável.</CardDescription>
          </CardHeader>
          <CardContent>
            <form ref={formArquivoRef} action={acaoArquivo} className="flex flex-col gap-4">
              {estadoArquivo.erro ? <Alert variant="destructive">{estadoArquivo.erro}</Alert> : null}
              {estadoArquivo.sucesso ? <Alert variant="success">{estadoArquivo.sucesso}</Alert> : null}
              <div className="flex flex-col gap-2">
                <Label htmlFor="arquivo">Arquivo</Label>
                <Input id="arquivo" name="arquivo" type="file" accept=".pdf,.docx,.txt" required />
              </div>
              <div>
                <SubmitButton pendingLabel="Enviando…">Enviar e processar</SubmitButton>
              </div>
            </form>
          </CardContent>
        </Card>

        {/* Texto colado */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileText className="h-4 w-4" aria-hidden />
              Colar texto
            </CardTitle>
            <CardDescription>Para conteúdo curto. Processa na hora, sem espera.</CardDescription>
          </CardHeader>
          <CardContent>
            <form ref={formTextoRef} action={acaoTexto} className="flex flex-col gap-4">
              {estadoTexto.erro ? <Alert variant="destructive">{estadoTexto.erro}</Alert> : null}
              {estadoTexto.sucesso ? <Alert variant="success">{estadoTexto.sucesso}</Alert> : null}
              <div className="flex flex-col gap-2">
                <Label htmlFor="titulo">Título</Label>
                <Input id="titulo" name="titulo" placeholder="Ex.: Horário de funcionamento" required />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="texto">Conteúdo</Label>
                <Textarea id="texto" name="texto" rows={5} required />
              </div>
              <div>
                <SubmitButton pendingLabel="Processando…">Adicionar à base</SubmitButton>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>

      {/* Processamentos em andamento / recentes */}
      {jobs.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Processamentos</CardTitle>
            <CardDescription>
              {temAtivo ? 'Atualizando automaticamente…' : 'Últimos envios.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {jobs.map((job) => {
              const pct =
                job.chunks_total > 0 ? Math.round((job.chunks_ok / job.chunks_total) * 100) : 0;
              return (
                <div key={job.id} className="rounded-md border border-border p-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="truncate text-sm font-medium">{job.arquivo_nome}</span>
                    <div className="flex shrink-0 items-center gap-2">
                      <StatusBadge status={job.status} />
                      {job.tipo === 'arquivo' && job.status === 'erro' ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={pendente}
                          onClick={() => aoReprocessar(job.id)}
                        >
                          <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Reprocessar
                        </Button>
                      ) : null}
                    </div>
                  </div>

                  {job.status === 'processando' ? (
                    <div className="mt-2">
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full bg-primary transition-all"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {job.chunks_ok}/{job.chunks_total || '…'} chunks
                      </p>
                    </div>
                  ) : null}

                  {job.status === 'erro' && job.erro_msg ? (
                    <p className="mt-1 text-xs text-destructive">{job.erro_msg}</p>
                  ) : null}
                </div>
              );
            })}
          </CardContent>
        </Card>
      ) : null}

      {/* Documentos na base */}
      <Card>
        <CardHeader>
          <CardTitle>Documentos na base</CardTitle>
          <CardDescription>
            {documentosIniciais.length === 0
              ? 'Nada ainda. Suba um arquivo ou cole um texto acima.'
              : `${documentosIniciais.length} documento(s), indexados para o agente.`}
          </CardDescription>
        </CardHeader>
        {documentosIniciais.length > 0 ? (
          <CardContent className="flex flex-col gap-2">
            {documentosIniciais.map((doc) => (
              <div
                key={doc.origem}
                className="flex items-center justify-between gap-3 rounded-md border border-border p-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{doc.nome}</p>
                  <p className="text-xs text-muted-foreground">
                    {doc.chunks} chunk(s) · {dataCurta(doc.criadoEm)}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={pendente}
                  onClick={() => aoExcluir(doc.origem, doc.nome)}
                  aria-label={`Excluir ${doc.nome}`}
                >
                  <Trash2 className="h-4 w-4" aria-hidden />
                </Button>
              </div>
            ))}
          </CardContent>
        ) : null}
      </Card>
    </div>
  );
}
