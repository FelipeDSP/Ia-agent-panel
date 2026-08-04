'use client';

import { useActionState } from 'react';

import { salvarConfigTenant, type EstadoConfig } from '../acoes';
import { Alert } from '@/components/ui/alert';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SubmitButton } from '@/components/ui/submit-button';
import { Textarea } from '@/components/ui/textarea';

function ErroCampo({ msg }: { msg?: string }) {
  if (!msg) return null;
  return <p className="text-xs text-destructive">{msg}</p>;
}

export function FormularioConfig({
  agenteAtivo,
  debounce,
  msgMidia,
  msgForaEscopo,
}: {
  agenteAtivo: boolean;
  debounce: number;
  msgMidia: string;
  msgForaEscopo: string;
}) {
  const [estado, acao] = useActionState<EstadoConfig, FormData>(salvarConfigTenant, {});

  return (
    <form action={acao} className="flex flex-col gap-5">
      {estado.erro ? <Alert variant="destructive">{estado.erro}</Alert> : null}
      {estado.sucesso ? <Alert variant="success">{estado.sucesso}</Alert> : null}

      <label className="flex items-center gap-3">
        <input
          type="checkbox"
          name="agente_ativo"
          defaultChecked={agenteAtivo}
          className="h-4 w-4 accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        />
        <span className="text-sm font-medium">Agente ligado</span>
      </label>
      <p className="-mt-3 text-xs text-muted-foreground">
        Desligado, o agente para de responder às conversas deste cliente.
      </p>

      <div className="flex max-w-xs flex-col gap-2">
        <Label htmlFor="debounce_segundos">Debounce (segundos)</Label>
        <Input
          id="debounce_segundos"
          name="debounce_segundos"
          type="number"
          min="1"
          max="60"
          defaultValue={debounce}
        />
        <p className="text-xs text-muted-foreground">
          Tempo de espera antes de o agente responder (1 a 60s).
        </p>
        <ErroCampo msg={estado.errosCampo?.['debounce_segundos']} />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="msg_midia_nao_suportada">Mensagem para mídia não suportada</Label>
        <Textarea
          id="msg_midia_nao_suportada"
          name="msg_midia_nao_suportada"
          rows={2}
          defaultValue={msgMidia}
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="msg_fora_escopo">Mensagem para fora de escopo</Label>
        <Textarea
          id="msg_fora_escopo"
          name="msg_fora_escopo"
          rows={2}
          defaultValue={msgForaEscopo}
        />
      </div>

      <div>
        <SubmitButton>Salvar configurações</SubmitButton>
      </div>
    </form>
  );
}
