'use client';

import { Check, Send, Sparkles } from 'lucide-react';
import { useActionState, useEffect, useRef, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { SubmitButton } from '@/components/ui/submit-button';
import { aplicar, perguntar, type EstadoAplicacao, type EstadoAssistente } from '@/lib/assistente/acoes';
import { contagem, diferenca, resumir } from '@/lib/assistente/diferenca';
import { TIPOS, type Proposta } from '@/lib/assistente/proposta';

/**
 * A CONVERSA e as propostas.
 *
 * A conversa vive no estado do componente, não no banco: ela é rascunho de
 * configuração, não histórico que alguém vá auditar, e guardá-la custaria uma
 * tabela, uma policy e uma política de retenção para nada. Recarregar a página
 * começa de novo — e o contexto da conta é relido a cada turno de qualquer
 * jeito, então nada se perde a não ser o que já foi dito.
 *
 * O BOTÃO DE APROVAR É O CONTRATO. O que ele manda é a proposta inteira, e o
 * servidor a revalida do zero (`lerPropostas`), confere o `baseHash` e escreve
 * pelas Server Actions que a tela de Prompt e a de Configurações já usam.
 * Aprovar aqui é idêntico a digitar aquilo lá.
 */

const DIAS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

type Fala = { de: 'cliente' | 'assistente'; texto: string };

export function Conversa({ promptAtual }: { promptAtual: string }) {
  const [estado, acao, pendente] = useActionState<EstadoAssistente, FormData>(perguntar, { fase: 'vazio' });
  const [falas, setFalas] = useState<Fala[]>([]);
  const [propostas, setPropostas] = useState<Proposta[]>([]);
  const [descartadas, setDescartadas] = useState<{ tipo: string; motivo: string }[]>([]);
  const campo = useRef<HTMLTextAreaElement>(null);
  const ultimo = useRef<EstadoAssistente | null>(null);

  // A resposta chega pelo estado da action; daqui ela entra na conversa. O
  // `ultimo` evita reprocessar o mesmo estado num re-render.
  useEffect(() => {
    if (estado === ultimo.current) return;
    ultimo.current = estado;
    if (estado.fase === 'ok') {
      setFalas((f) => [...f, { de: 'assistente', texto: estado.resultado.texto }]);
      setPropostas(estado.resultado.propostas);
      setDescartadas(estado.resultado.descartadas);
    }
  }, [estado]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Sparkles className="h-4 w-4 text-primary" aria-hidden />
          Pergunte ao assistente
        </CardTitle>
        <CardDescription>
          Ele conhece o prompt, o horário, o catálogo e a base desta conta. Exemplos: &ldquo;por que o
          agente não responde preço?&rdquo;, &ldquo;deixa meu prompt mais curto&rdquo;, &ldquo;o que está
          atrapalhando meu atendimento?&rdquo;
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {falas.length > 0 ? (
          <div className="flex flex-col gap-3">
            {falas.map((f, i) => (
              <div
                key={i}
                className={f.de === 'cliente'
                  ? 'self-end rounded-2xl rounded-br-sm bg-primary px-4 py-2 text-sm text-primary-foreground max-w-[85%] whitespace-pre-wrap'
                  : 'self-start rounded-2xl rounded-bl-sm bg-muted px-4 py-3 text-sm max-w-[95%] whitespace-pre-wrap'}
              >
                {f.texto}
              </div>
            ))}
          </div>
        ) : null}

        {estado.fase === 'erro' ? <Alert variant="destructive">{estado.erro}</Alert> : null}

        {estado.fase === 'ok' && estado.resultado.truncado ? (
          <Alert>A resposta ficou longa e foi cortada. Tente uma pergunta mais específica.</Alert>
        ) : null}

        <form
          action={acao}
          className="flex flex-col gap-2"
          onSubmit={() => {
            const texto = campo.current?.value?.trim();
            if (texto) setFalas((f) => [...f, { de: 'cliente', texto }]);
            setPropostas([]);
            setDescartadas([]);
          }}
        >
          {/* O histórico volta ao servidor pelo formulário: a conversa é do
              navegador, e o servidor não guarda sessão para isto. Ele corta
              por tamanho e quantidade antes de mandar ao modelo. */}
          <input
            type="hidden"
            name="historico"
            value={JSON.stringify(falas.map((f) => ({ papel: f.de === 'cliente' ? 'user' : 'assistant', texto: f.texto })))}
          />
          <textarea
            ref={campo}
            name="pergunta"
            rows={2}
            required
            maxLength={2000}
            placeholder="O que você quer saber ou mudar?"
            className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              O assistente nunca muda nada sozinho: ele propõe e você aprova.
            </p>
            <SubmitButton className="gap-2">
              <Send className="h-4 w-4" aria-hidden />
              {pendente ? 'Pensando...' : 'Perguntar'}
            </SubmitButton>
          </div>
        </form>

        {propostas.length > 0 ? (
          <div className="flex flex-col gap-4 border-t border-border pt-4">
            <p className="text-sm font-medium">
              {propostas.length === 1 ? 'Proposta do assistente' : `${propostas.length} propostas do assistente`}
            </p>
            {propostas.map((p, i) => (
              <CartaoProposta key={i} proposta={p} promptAtual={promptAtual} />
            ))}
          </div>
        ) : null}

        {/* Descarte VISÍVEL. O assistente pode sugerir algo que o painel não
            sabe aplicar; dizer isso é melhor que ele parecer concordar e nada
            acontecer. */}
        {descartadas.length > 0 ? (
          <div className="rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
            <p className="font-medium text-foreground">O assistente sugeriu algo que eu não sei aplicar</p>
            <ul className="mt-1.5 flex list-disc flex-col gap-1 pl-4">
              {descartadas.map((d, i) => <li key={i}>{d.motivo}</li>)}
            </ul>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

/**
 * Um cartão de proposta: o que muda, por quê, a diferença, e o botão.
 *
 * A diferença é o ponto. O cliente aprova o prompt INTEIRO reescrito, e sem ver
 * o que saiu e o que entrou ele está assinando em branco um texto de 12 KB.
 */
function CartaoProposta({ proposta, promptAtual }: { proposta: Proposta; promptAtual: string }) {
  const [estado, acao] = useActionState<EstadoAplicacao, FormData>(aplicar, {});
  const [aberto, setAberto] = useState(false);
  const rotulo = TIPOS[proposta.tipo];

  // O prompt atual desce do servidor, que já o leu para montar o retrato. Uma
  // rota só para buscá-lo seria superficie nova para economizar 12 KB de HTML.
  const pedacos = proposta.tipo === 'prompt' ? diferenca(promptAtual, proposta.texto) : null;
  const n = pedacos ? contagem(pedacos) : null;

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border p-4">
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium">{proposta.titulo}</p>
        <p className="text-sm text-muted-foreground">{proposta.porque}</p>
        <p className="text-xs text-muted-foreground">Onde se aplica: {rotulo.onde}</p>
      </div>

      {proposta.tipo === 'horario' ? (
        <ul className="flex flex-col gap-1 text-sm">
          {proposta.janelas.map((j, i) => (
            <li key={i} className="font-mono text-xs">
              {j.dias.map((d) => DIAS[d]).join(', ')} — {j.inicio} às {j.fim}
            </li>
          ))}
        </ul>
      ) : (
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={() => setAberto((v) => !v)}
            aria-expanded={aberto}
            className="self-start text-xs font-medium text-primary underline-offset-2 hover:underline"
          >
            {aberto ? 'Esconder o que muda' : 'Ver o que muda no prompt'}
            {n ? ` (${n.fora} ${n.fora === 1 ? 'linha sai' : 'linhas saem'}, ${n.dentro} ${n.dentro === 1 ? 'entra' : 'entram'})` : ''}
          </button>
          {aberto && pedacos ? (
            <div className="max-h-80 overflow-auto rounded-md border border-border bg-muted/30 font-mono text-xs leading-relaxed">
                {resumir(pedacos).map((p, i) => {
                  if (p.tipo === 'pulo') {
                    return (
                      <div key={i} className="bg-muted px-3 py-1 text-muted-foreground">
                        … {p.linhas} {p.linhas === 1 ? 'linha igual' : 'linhas iguais'} …
                      </div>
                    );
                  }
                  return p.linhas.map((l, k) => (
                    <div
                      key={`${i}-${k}`}
                      className={p.tipo === 'fora'
                        ? 'whitespace-pre-wrap bg-destructive/10 px-3 text-destructive'
                        : p.tipo === 'dentro'
                          ? 'whitespace-pre-wrap bg-emerald-500/10 px-3 text-emerald-700 dark:text-emerald-400'
                          : 'whitespace-pre-wrap px-3 text-muted-foreground'}
                    >
                      {p.tipo === 'fora' ? '− ' : p.tipo === 'dentro' ? '+ ' : '  '}
                      {l || ' '}
                    </div>
                  ));
              })}
            </div>
          ) : null}
        </div>
      )}

      {estado.erro ? <Alert variant="destructive">{estado.erro}</Alert> : null}
      {estado.sucesso ? <Alert variant="success">{estado.sucesso}</Alert> : null}

      {estado.sucesso ? null : (
        <form action={acao} className="flex items-center gap-3">
          <input type="hidden" name="proposta" value={JSON.stringify(proposta)} />
          <SubmitButton className="gap-2">
            <Check className="h-4 w-4" aria-hidden />
            Aprovar e aplicar
          </SubmitButton>
          <span className="text-xs text-muted-foreground">{rotulo.rotulo}</span>
        </form>
      )}
    </div>
  );
}
