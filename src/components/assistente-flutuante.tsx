'use client';

import {
  AlertTriangle, Check, CircleAlert, Info, Loader2, Send, Sparkles, X,
} from 'lucide-react';
import { useActionState, useEffect, useRef, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { SubmitButton } from '@/components/ui/submit-button';
import {
  abrir, aplicar, perguntar,
  type Abertura, type EstadoAplicacao, type EstadoAssistente,
} from '@/lib/assistente/acoes';
import { contagem, diferenca, resumir } from '@/lib/assistente/diferenca';
import type { Gravidade } from '@/lib/assistente/deteccoes';
import { TIPOS, type Proposta } from '@/lib/assistente/proposta';

/**
 * O ASSISTENTE COMO BOLHA, em toda tela do painel.
 *
 * Era uma aba própria e virou bolha a pedido do Felipe (15/10), no modelo do
 * Kodee da Hostinger. A diferença não é estética: numa aba, o assistente é um
 * lugar aonde se vai quando já se sabe que há um problema; numa bolha, ele está
 * ali no momento em que a dúvida aparece — enquanto a pessoa mexe no prompt,
 * no catálogo ou no horário, que é quando ela tem a pergunta.
 *
 * NADA É CARREGADO ATÉ ABRIR. A bolha fechada é um botão: nenhuma consulta,
 * nenhum token. `abrir()` lê o retrato uma vez; perguntar é que custa modelo,
 * e o custo é da agência.
 *
 * Só para `tenant_admin` — quem monta isto é o layout, que sabe o papel. O
 * assistente mexe em prompt e horário, decisão de quem é dono da conta.
 */

const ICONE: Record<Gravidade, typeof CircleAlert> = {
  erro: CircleAlert,
  aviso: AlertTriangle,
  nota: Info,
};
const COR: Record<Gravidade, string> = {
  erro: 'text-destructive',
  aviso: 'text-amber-600 dark:text-amber-500',
  nota: 'text-muted-foreground',
};
const DIAS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

type Fala = { de: 'cliente' | 'assistente'; texto: string };

export function AssistenteFlutuante() {
  const [aberto, setAberto] = useState(false);
  const [dados, setDados] = useState<Abertura | null>(null);
  const [carregando, setCarregando] = useState(false);
  const [falhouAbrir, setFalhouAbrir] = useState<string | null>(null);

  const [estado, acao, pendente] = useActionState<EstadoAssistente, FormData>(perguntar, { fase: 'vazio' });
  const [falas, setFalas] = useState<Fala[]>([]);
  const [propostas, setPropostas] = useState<Proposta[]>([]);
  const [descartadas, setDescartadas] = useState<{ tipo: string; motivo: string }[]>([]);
  const campo = useRef<HTMLTextAreaElement>(null);
  const fim = useRef<HTMLDivElement>(null);
  const ultimo = useRef<EstadoAssistente | null>(null);

  // O retrato é lido na PRIMEIRA abertura e reaproveitado enquanto a página
  // vive. Aplicar uma proposta recarrega a página (revalidatePath), e aí ele é
  // lido de novo — então o que a bolha mostra não fica velho sem avisar.
  useEffect(() => {
    if (!aberto || dados || carregando) return;
    setCarregando(true);
    abrir()
      .then((d) => { setDados(d); setFalhouAbrir(null); })
      .catch((e: unknown) => setFalhouAbrir(e instanceof Error ? e.message : String(e)))
      .finally(() => setCarregando(false));
  }, [aberto, dados, carregando]);

  useEffect(() => {
    if (estado === ultimo.current) return;
    ultimo.current = estado;
    if (estado.fase === 'ok') {
      setFalas((f) => [...f, { de: 'assistente', texto: estado.resultado.texto }]);
      setPropostas(estado.resultado.propostas);
      setDescartadas(estado.resultado.descartadas);
    }
  }, [estado]);

  // A conversa rola sozinha para a última fala; sem isto a resposta nova nasce
  // fora da vista num painel desta altura.
  useEffect(() => { fim.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [falas, propostas, pendente]);

  // Esc fecha, como todo painel sobreposto. Só quando aberto, para não roubar
  // a tecla de quem está editando o prompt na página atrás.
  useEffect(() => {
    if (!aberto) return;
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') setAberto(false); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [aberto]);

  if (!aberto) {
    return (
      <button
        type="button"
        onClick={() => setAberto(true)}
        aria-label="Abrir o assistente de configuração"
        className="fixed bottom-5 right-5 z-50 flex h-14 w-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg transition hover:brightness-110 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
      >
        <Sparkles className="h-6 w-6" aria-hidden />
      </button>
    );
  }

  const erros = dados?.achados.filter((a) => a.gravidade === 'erro').length ?? 0;

  return (
    <div className="fixed inset-x-0 bottom-0 z-50 flex justify-end p-0 sm:inset-auto sm:bottom-5 sm:right-5">
      <div className="flex h-[85vh] w-full flex-col overflow-hidden border border-border bg-background shadow-2xl sm:h-[36rem] sm:w-[27rem] sm:rounded-2xl">
        <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" aria-hidden />
            <span className="text-sm font-semibold">Assistente</span>
          </div>
          <button
            type="button"
            onClick={() => setAberto(false)}
            aria-label="Fechar o assistente"
            className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-4 py-3">
          {carregando && !dados ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Olhando sua conta…
            </p>
          ) : null}

          {falhouAbrir ? <Alert variant="destructive">Não consegui ler sua conta: {falhouAbrir}</Alert> : null}

          {/* Os achados mecânicos abrem a conversa: eles não custam nada e são
              a resposta para a pergunta que a pessoa ia fazer de qualquer jeito. */}
          {dados && falas.length === 0 ? (
            <div className="flex flex-col gap-3">
              <p className="text-sm">
                {dados.achados.length === 0
                  ? 'Olhei sua configuração e não encontrei nada fora de lugar. Pode me perguntar o que quiser sobre o seu agente.'
                  : `Olhei sua configuração e encontrei ${dados.achados.length} ${dados.achados.length === 1 ? 'ponto de atenção' : 'pontos de atenção'}${erros > 0 ? `, ${erros === 1 ? 'sendo 1 que atrapalha o atendimento agora' : `sendo ${erros} que atrapalham o atendimento agora`}` : ''}:`}
              </p>
              {dados.achados.map((a) => {
                const Icone = ICONE[a.gravidade];
                return (
                  <div key={a.chave} className="flex items-start gap-2 rounded-lg border border-border p-3">
                    <Icone className={`mt-0.5 h-4 w-4 shrink-0 ${COR[a.gravidade]}`} aria-hidden />
                    <div className="flex flex-col gap-0.5">
                      <p className="text-sm font-medium">{a.titulo}</p>
                      <p className="text-xs text-muted-foreground">{a.detalhe}</p>
                      <p className="text-[11px] text-muted-foreground">Onde se ajusta: {a.onde}</p>
                    </div>
                  </div>
                );
              })}
              {dados.errosDeLeitura.length > 0 ? (
                <Alert>
                  Não consegui ler parte da sua conta ({dados.errosDeLeitura.length}).
                  Vou responder sem essa parte.
                </Alert>
              ) : null}
            </div>
          ) : null}

          {falas.length > 0 ? (
            <div className="flex flex-col gap-3">
              {falas.map((f, i) => (
                <div
                  key={i}
                  className={f.de === 'cliente'
                    ? 'max-w-[90%] self-end whitespace-pre-wrap rounded-2xl rounded-br-sm bg-primary px-3 py-2 text-sm text-primary-foreground'
                    : 'max-w-[95%] self-start whitespace-pre-wrap rounded-2xl rounded-bl-sm bg-muted px-3 py-2 text-sm'}
                >
                  {f.texto}
                </div>
              ))}
            </div>
          ) : null}

          {pendente ? (
            <p className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Pensando…
            </p>
          ) : null}

          {estado.fase === 'erro' ? <Alert variant="destructive">{estado.erro}</Alert> : null}
          {estado.fase === 'ok' && estado.resultado.truncado ? (
            <Alert>A resposta ficou longa e foi cortada. Tente uma pergunta mais específica.</Alert>
          ) : null}

          {propostas.length > 0 ? (
            <div className="mt-4 flex flex-col gap-3">
              {propostas.map((p, i) => (
                <CartaoProposta key={i} proposta={p} promptAtual={dados?.promptAtual ?? ''} />
              ))}
            </div>
          ) : null}

          {descartadas.length > 0 ? (
            <div className="mt-3 rounded-md border border-border bg-muted/40 p-2 text-[11px] text-muted-foreground">
              <p className="font-medium text-foreground">Sugeri algo que o painel não sabe aplicar</p>
              <ul className="mt-1 flex list-disc flex-col gap-0.5 pl-4">
                {descartadas.map((d, i) => <li key={i}>{d.motivo}</li>)}
              </ul>
            </div>
          ) : null}

          <div ref={fim} />
        </div>

        <form
          action={acao}
          className="border-t border-border p-3"
          onSubmit={() => {
            /*
             * NÃO LIMPE O CAMPO AQUI. `onSubmit` roda ANTES de o React montar
             * o FormData da action, então zerar o valor agora manda a pergunta
             * vazia — e a tela responde "Escreva sua pergunta." com o texto do
             * cliente visível no balão. Aconteceu na primeira versão da bolha,
             * e só apareceu clicando: a limpeza não existia na versão de
             * página, então nenhum teste cobria isso.
             *
             * Quem limpa é o React, que reseta formulário não-controlado
             * depois de a action terminar.
             */
            const texto = campo.current?.value?.trim();
            if (texto) setFalas((f) => [...f, { de: 'cliente', texto }]);
            setPropostas([]);
            setDescartadas([]);
          }}
        >
          <input
            type="hidden"
            name="historico"
            value={JSON.stringify(falas.map((f) => ({ papel: f.de === 'cliente' ? 'user' : 'assistant', texto: f.texto })))}
          />
          <div className="flex items-end gap-2">
            <textarea
              ref={campo}
              name="pergunta"
              rows={2}
              required
              maxLength={2000}
              placeholder="O que você quer saber ou mudar?"
              className="min-h-[2.5rem] w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              onKeyDown={(e) => {
                // Enter manda, Shift+Enter quebra linha — é o que todo mundo
                // espera de um chat, e o form só tem este campo.
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  e.currentTarget.form?.requestSubmit();
                }
              }}
            />
            <SubmitButton size="icon" aria-label="Perguntar">
              <Send className="h-4 w-4" aria-hidden />
            </SubmitButton>
          </div>
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            Ele propõe; nada muda sem você aprovar.
          </p>
        </form>
      </div>
    </div>
  );
}

/** Um cartão de proposta: o que muda, a diferença, e o botão que aplica. */
function CartaoProposta({ proposta, promptAtual }: { proposta: Proposta; promptAtual: string }) {
  const [estado, acao] = useActionState<EstadoAplicacao, FormData>(aplicar, {});
  const [aberto, setAberto] = useState(false);
  const rotulo = TIPOS[proposta.tipo];

  // A diferença é o ponto: o cliente aprova o prompt INTEIRO reescrito, e sem
  // ver o que saiu e o que entrou ele assina em branco um texto de 12 KB.
  const pedacos = proposta.tipo === 'prompt' ? diferenca(promptAtual, proposta.texto) : null;
  const n = pedacos ? contagem(pedacos) : null;

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-primary/40 bg-primary/5 p-3">
      <p className="text-sm font-medium">{proposta.titulo}</p>
      <p className="text-xs text-muted-foreground">{proposta.porque}</p>
      <p className="text-[11px] text-muted-foreground">Onde se aplica: {rotulo.onde}</p>

      {proposta.tipo === 'horario' ? (
        <ul className="flex flex-col gap-0.5 font-mono text-[11px]">
          {proposta.janelas.map((j, i) => (
            <li key={i}>{j.dias.map((d) => DIAS[d]).join(', ')} — {j.inicio} às {j.fim}</li>
          ))}
        </ul>
      ) : (
        <>
          <button
            type="button"
            onClick={() => setAberto((v) => !v)}
            aria-expanded={aberto}
            className="self-start text-xs font-medium text-primary underline-offset-2 hover:underline"
          >
            {aberto ? 'Esconder o que muda' : 'Ver o que muda'}
            {n ? ` (${n.fora} ${n.fora === 1 ? 'sai' : 'saem'}, ${n.dentro} ${n.dentro === 1 ? 'entra' : 'entram'})` : ''}
          </button>
          {aberto && pedacos ? (
            <div className="max-h-56 overflow-auto rounded-md border border-border bg-background font-mono text-[11px] leading-relaxed">
              {resumir(pedacos).map((p, i) => {
                if (p.tipo === 'pulo') {
                  return (
                    <div key={i} className="bg-muted px-2 py-0.5 text-muted-foreground">
                      … {p.linhas} {p.linhas === 1 ? 'linha igual' : 'linhas iguais'} …
                    </div>
                  );
                }
                return p.linhas.map((l, k) => (
                  <div
                    key={`${i}-${k}`}
                    className={p.tipo === 'fora'
                      ? 'whitespace-pre-wrap bg-destructive/10 px-2 text-destructive'
                      : p.tipo === 'dentro'
                        ? 'whitespace-pre-wrap bg-emerald-500/10 px-2 text-emerald-700 dark:text-emerald-400'
                        : 'whitespace-pre-wrap px-2 text-muted-foreground'}
                  >
                    {p.tipo === 'fora' ? '− ' : p.tipo === 'dentro' ? '+ ' : '  '}{l || ' '}
                  </div>
                ));
              })}
            </div>
          ) : null}
        </>
      )}

      {estado.erro ? <Alert variant="destructive">{estado.erro}</Alert> : null}
      {estado.sucesso ? <Alert variant="success">{estado.sucesso}</Alert> : null}

      {estado.sucesso ? null : (
        <form action={acao}>
          <input type="hidden" name="proposta" value={JSON.stringify(proposta)} />
          <SubmitButton size="sm" className="gap-2">
            <Check className="h-4 w-4" aria-hidden />
            Aprovar e aplicar
          </SubmitButton>
        </form>
      )}
    </div>
  );
}
