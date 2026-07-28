'use client';

import { Pause, Play } from 'lucide-react';
import { useState, useTransition } from 'react';

import { definirStatusConversa, type EstadoConversa } from '../acoes';
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
        {pausado ? (
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
