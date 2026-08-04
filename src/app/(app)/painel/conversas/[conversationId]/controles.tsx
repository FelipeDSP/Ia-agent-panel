'use client';

import { Eraser, Pause, Play } from 'lucide-react';
import { useState, useTransition } from 'react';

import {
  definirStatusConversa,
  limparMemoriaConversas,
  type EstadoConversa,
} from '../acoes';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

/**
 * Botão de pausar/retomar o agente na conversa. Pausado, o workflow do n8n não
 * responde esta conversa (ele lê o status). O estado inicial vem do servidor;
 * atualizamos otimista após a ação e o revalidatePath sincroniza.
 */
export function ControlePausa({
  conversationId,
  statusInicial,
}: {
  conversationId: number;
  statusInicial: string;
}) {
  const [status, setStatus] = useState(statusInicial);
  const [feedback, setFeedback] = useState<EstadoConversa>({});
  const [pendente, iniciar] = useTransition();

  const pausado = status === 'pausado';

  const alternar = () =>
    iniciar(async () => {
      const alvo = pausado ? 'ativo' : 'pausado';
      const r = await definirStatusConversa(conversationId, alvo);
      setFeedback(r);
      if (!r.erro) setStatus(alvo);
    });

  return (
    <div className="flex flex-col gap-2">
      <Button
        variant={pausado ? 'default' : 'outline'}
        size="sm"
        disabled={pendente}
        onClick={alternar}
      >
        {pendente ? (
          pausado ? (
            'Retomando…'
          ) : (
            'Pausando…'
          )
        ) : pausado ? (
          <>
            <Play className="h-4 w-4" aria-hidden /> Retomar agente
          </>
        ) : (
          <>
            <Pause className="h-4 w-4" aria-hidden /> Pausar agente
          </>
        )}
      </Button>
      {feedback.erro ? <Alert variant="destructive">{feedback.erro}</Alert> : null}
      {feedback.sucesso ? <Alert variant="success">{feedback.sucesso}</Alert> : null}
    </div>
  );
}

/**
 * Limpa a memória (Redis, via n8n) desta conversa. Confirmação em dois passos
 * inline — sem window.confirm (dialog nativo trava e é feio). Não apaga o
 * histórico exibido, só o contexto que o agente carrega.
 */
export function LimparMemoria({ conversationId }: { conversationId: number }) {
  const [confirmando, setConfirmando] = useState(false);
  const [feedback, setFeedback] = useState<EstadoConversa>({});
  const [pendente, iniciar] = useTransition();

  const limpar = () =>
    iniciar(async () => {
      const r = await limparMemoriaConversas([conversationId]);
      setFeedback(r);
      setConfirmando(false);
    });

  return (
    <div className="flex flex-col items-end gap-2">
      {confirmando ? (
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Limpar memória?</span>
          <Button variant="destructive" size="sm" disabled={pendente} onClick={limpar}>
            Confirmar
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={pendente}
            onClick={() => setConfirmando(false)}
          >
            Cancelar
          </Button>
        </div>
      ) : (
        <Button variant="outline" size="sm" onClick={() => setConfirmando(true)}>
          <Eraser className="h-4 w-4" aria-hidden /> Limpar memória
        </Button>
      )}
      {feedback.erro ? <Alert variant="destructive">{feedback.erro}</Alert> : null}
      {feedback.sucesso ? <Alert variant="success">{feedback.sucesso}</Alert> : null}
    </div>
  );
}
