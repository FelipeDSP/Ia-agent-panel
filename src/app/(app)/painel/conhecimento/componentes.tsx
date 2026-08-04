'use client';

import { Eye, EyeOff, FileText, RefreshCw, Trash2, Upload } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useRef, useState, useTransition } from 'react';

import {
  excluirDocumento,
  ingerirTexto,
  listarStatusJobs,
  reprocessar,
  subirArquivo,
  verConteudoDocumento,
  type ChunkConteudo,
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
import { cn } from '@/lib/utils';

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

/**
 * Excluir documento com confirmação inline em dois passos — mesmo padrão do
 * LimparMemoria. Apagar um documento remove os chunks da base do agente; um
 * clique só era fácil demais de errar.
 */
function BotaoExcluirDocumento({
  nome,
  desabilitado,
  excluindo,
  onConfirmar,
}: {
  nome: string;
  desabilitado: boolean;
  excluindo: boolean;
  onConfirmar: () => void;
}) {
  const [confirmando, setConfirmando] = useState(false);

  if (!confirmando) {
    return (
      <Button
        variant="ghost"
        size="sm"
        disabled={desabilitado}
        onClick={() => setConfirmando(true)}
        aria-label={`Excluir ${nome}`}
      >
        <Trash2 className="h-4 w-4" aria-hidden />
      </Button>
    );
  }

  return (
    <div className="flex shrink-0 items-center gap-2">
      <span className="text-xs text-muted-foreground">Excluir?</span>
      <Button variant="destructive" size="sm" disabled={desabilitado} onClick={onConfirmar}>
        {excluindo ? 'Excluindo…' : 'Confirmar'}
      </Button>
      <Button
        variant="outline"
        size="sm"
        disabled={desabilitado}
        onClick={() => setConfirmando(false)}
      >
        Cancelar
      </Button>
    </div>
  );
}

/**
 * Linha de um documento na base, com opção de ver o conteúdo indexado. O texto
 * dos chunks é carregado sob demanda (só na primeira abertura) — não faz sentido
 * trazer o corpo de todos os documentos no carregamento da página. Mostrar os
 * trechos é o que responde à dúvida "subi o arquivo certo?": é exatamente o que
 * o agente lê.
 */
function DocumentoItem({
  doc,
  desabilitado,
  excluindo,
  onExcluir,
}: {
  doc: Documento;
  desabilitado: boolean;
  excluindo: boolean;
  onExcluir: () => void;
}) {
  const [aberto, setAberto] = useState(false);
  const [chunks, setChunks] = useState<ChunkConteudo[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, iniciar] = useTransition();

  const alternar = () => {
    const proximo = !aberto;
    setAberto(proximo);
    // Carrega uma vez só, na primeira abertura.
    if (proximo && chunks === null && !carregando) {
      iniciar(async () => {
        const r = await verConteudoDocumento(doc.origem);
        if (r.erro) setErro(r.erro);
        else setChunks(r.chunks);
      });
    }
  };

  return (
    <div className="rounded-md border border-border">
      <div className="flex items-center justify-between gap-3 p-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{doc.nome}</p>
          <p className="text-xs text-muted-foreground">
            {doc.chunks} chunk(s) · {dataCurta(doc.criadoEm)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={alternar}
            aria-expanded={aberto}
            aria-label={aberto ? `Ocultar conteúdo de ${doc.nome}` : `Ver conteúdo de ${doc.nome}`}
          >
            {aberto ? (
              <EyeOff className="h-4 w-4" aria-hidden />
            ) : (
              <Eye className="h-4 w-4" aria-hidden />
            )}
            {aberto ? 'Ocultar' : 'Ver conteúdo'}
          </Button>
          <BotaoExcluirDocumento
            nome={doc.nome}
            desabilitado={desabilitado}
            excluindo={excluindo}
            onConfirmar={onExcluir}
          />
        </div>
      </div>

      {aberto ? (
        <div className="border-t border-border p-3">
          {carregando ? (
            <p className="text-sm text-muted-foreground">Carregando conteúdo…</p>
          ) : erro ? (
            <Alert variant="destructive">{erro}</Alert>
          ) : chunks && chunks.length > 0 ? (
            <>
              <p className="mb-3 text-xs text-muted-foreground">
                {chunks.length} trecho(s) indexado(s) — é o texto que o agente consulta. Pode haver
                pequena sobreposição entre trechos.
              </p>
              <div className="flex max-h-96 flex-col divide-y divide-border overflow-y-auto rounded-md bg-muted/40">
                {chunks.map((c, i) => (
                  <div key={i} className="flex flex-col gap-1 p-3">
                    <span className="text-xs font-medium text-muted-foreground">Trecho {i + 1}</span>
                    <p className="whitespace-pre-wrap break-words text-sm">{c.texto}</p>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              Sem conteúdo indexado para este documento.
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
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
  // Qual ação está em curso (ex.: `excluir:<origem>`). O `pendente` do
  // useTransition é compartilhado entre reprocessar e excluir; isto identifica o
  // botão exato para mostrar "…" só nele.
  const [acaoAtiva, setAcaoAtiva] = useState<string | null>(null);

  const [estadoArquivo, acaoArquivo] = useActionState<EstadoIngestao, FormData>(subirArquivo, {});
  const [estadoTexto, acaoTexto] = useActionState<EstadoIngestao, FormData>(ingerirTexto, {});

  const formArquivoRef = useRef<HTMLFormElement>(null);
  const formTextoRef = useRef<HTMLFormElement>(null);

  const temAtivo = jobs.some((j) => ATIVO.has(j.status));
  // Só mostramos jobs que pedem atenção: em andamento (progresso ao vivo) ou com
  // erro (motivo + reprocessar). Concluído some — já aparece em "Documentos na
  // base"; mantê-lo aqui só duplicaria a informação e poluiria a tela.
  const jobsRelevantes = jobs.filter((j) => j.status !== 'concluido');

  // Polling do progresso enquanto houver job na fila ou processando. Ao terminar
  // um job, atualiza a lista de documentos (router.refresh re-roda o Server
  // Component da pagina).
  useEffect(() => {
    if (!temAtivo) return;
    let vivo = true;
    const timer = setInterval(async () => {
      const atuais = await listarStatusJobs();
      if (!vivo) return;
      setJobs(atuais);
      // Efeito colateral fora do updater de setState (rodar router.refresh
      // dentro dele dispara duas vezes no strict mode). O efeito só está ativo
      // quando havia job em andamento; quando nenhum resta, acabou de terminar
      // → reidrata os documentos.
      const aindaAtivo = atuais.some((j) => ATIVO.has(j.status));
      if (!aindaAtivo) router.refresh();
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
      setAcaoAtiva(`reprocessar:${jobId}`);
      setFeedback(await reprocessar(jobId));
      setJobs(await listarStatusJobs());
      setAcaoAtiva(null);
    });

  const aoExcluir = (origem: string) =>
    iniciarTransicao(async () => {
      setAcaoAtiva(`excluir:${origem}`);
      setFeedback(await excluirDocumento(origem));
      router.refresh();
      setAcaoAtiva(null);
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

      {/* Processamentos: só o que pede atenção (em andamento ou com erro). */}
      {jobsRelevantes.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Processamentos</CardTitle>
            <CardDescription>
              {temAtivo ? 'Atualizando automaticamente…' : 'Envios que precisam de atenção.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {jobsRelevantes.map((job) => {
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
                          <RefreshCw
                            className={cn(
                              'h-3.5 w-3.5',
                              acaoAtiva === `reprocessar:${job.id}` && 'animate-spin',
                            )}
                            aria-hidden
                          />
                          {acaoAtiva === `reprocessar:${job.id}` ? 'Reprocessando…' : 'Reprocessar'}
                        </Button>
                      ) : null}
                    </div>
                  </div>

                  {job.status === 'processando' ? (
                    <div className="mt-2">
                      <div
                        role="progressbar"
                        aria-valuenow={pct}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-label={`Progresso de ${job.arquivo_nome}`}
                        className="h-2 w-full overflow-hidden rounded-full bg-muted"
                      >
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
              <DocumentoItem
                key={doc.origem}
                doc={doc}
                desabilitado={pendente}
                excluindo={acaoAtiva === `excluir:${doc.origem}`}
                onExcluir={() => aoExcluir(doc.origem)}
              />
            ))}
          </CardContent>
        ) : null}
      </Card>
    </div>
  );
}
