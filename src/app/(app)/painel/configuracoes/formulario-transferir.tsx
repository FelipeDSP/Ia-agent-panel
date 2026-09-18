'use client';

import { useActionState, useState } from 'react';

import { salvarTransferirHumano } from '../acoes';
import { type EstadoConfig } from '../acoes';
import { Alert } from '@/components/ui/alert';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { SubmitButton } from '@/components/ui/submit-button';
import { DIAS_SEMANA, TIMEZONES_BR, type Horario } from '@/lib/tools/transferir-humano';

function ErroCampo({ msg }: { msg?: string }) {
  if (!msg) return null;
  return <p className="text-xs text-destructive">{msg}</p>;
}

const CHECK =
  'h-4 w-4 accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background';

/**
 * Quando há atendente humano. Reescrito em 18/09: a notificação saiu daqui
 * (mora em "Avisos para você", junto com a de vendas — era o mesmo número
 * pedido duas vezes), e o horário padrão passou a ser o da loja, que já está
 * em "Horário de atendimento" (era o segundo "Fuso horário / Dias / Abre às"
 * da mesma tela). Só quem tem atendente em horário diferente do da loja abre
 * os campos próprios.
 */
export function FormularioTransferir({
  ativo,
  horario,
  horarioDaLoja,
  lojaTemHorario,
}: {
  ativo: boolean;
  horario: Horario;
  horarioDaLoja: boolean;
  lojaTemHorario: boolean;
}) {
  const [estado, acao] = useActionState<EstadoConfig, FormData>(salvarTransferirHumano, {});
  const [quando, setQuando] = useState<'loja' | 'proprio'>(horarioDaLoja ? 'loja' : 'proprio');

  return (
    <form action={acao} className="flex flex-col gap-5">
      {estado.erro ? <Alert variant="destructive">{estado.erro}</Alert> : null}
      {estado.sucesso ? <Alert variant="success">{estado.sucesso}</Alert> : null}

      {!ativo ? (
        <Alert>Desligado: o que você ajustar aqui só passa a valer quando ligar o botão acima.</Alert>
      ) : null}

      <fieldset className="flex flex-col gap-3 rounded-xl border border-border p-4">
        <legend className="px-1 text-sm font-medium">Quando há alguém para atender</legend>
        <label className="flex items-start gap-3 text-sm">
          <input type="radio" name="quando" value="loja" checked={quando === 'loja'} onChange={() => setQuando('loja')} className={`${CHECK} mt-0.5`} />
          <span className="flex flex-col">
            <span>No horário de atendimento da loja</span>
            <span className="text-xs text-muted-foreground">
              {lojaTemHorario
                ? 'O mesmo horário configurado acima, em “Horário de atendimento”.'
                : 'A loja ainda não tem horário configurado acima — até lá, sempre há atendente.'}
            </span>
          </span>
        </label>
        <label className="flex items-start gap-3 text-sm">
          <input type="radio" name="quando" value="proprio" checked={quando === 'proprio'} onChange={() => setQuando('proprio')} className={`${CHECK} mt-0.5`} />
          <span className="flex flex-col">
            <span>Em outro horário</span>
            <span className="text-xs text-muted-foreground">Ex.: a loja abre às 7h, mas quem atende pelo WhatsApp entra às 9h.</span>
          </span>
        </label>

        {quando === 'proprio' ? (
          <div className="mt-2 flex flex-col gap-4 border-t border-border pt-4">
            <div className="flex max-w-xs flex-col gap-2">
              <Label htmlFor="timezone">Fuso horário</Label>
              <Select id="timezone" name="timezone" defaultValue={horario.timezone}>
                {TIMEZONES_BR.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
              </Select>
              <ErroCampo msg={estado.errosCampo?.['timezone']} />
            </div>
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium">Dias</span>
              <div className="flex flex-wrap gap-3">
                {DIAS_SEMANA.map((d) => (
                  <label key={d.valor} className="flex items-center gap-1.5 text-sm">
                    <input type="checkbox" name={`dia_${d.valor}`} defaultChecked={horario.dias_semana.includes(d.valor)} className={CHECK} />
                    {d.nome}
                  </label>
                ))}
              </div>
              <ErroCampo msg={estado.errosCampo?.['dias_semana']} />
            </div>
            <div className="flex gap-4">
              <div className="flex w-28 flex-col gap-2">
                <Label htmlFor="hora_inicio">Entra às</Label>
                <Input id="hora_inicio" name="hora_inicio" type="number" min="0" max="23" defaultValue={horario.hora_inicio} />
                <ErroCampo msg={estado.errosCampo?.['hora_inicio']} />
              </div>
              <div className="flex w-28 flex-col gap-2">
                <Label htmlFor="hora_fim">Sai às</Label>
                <Input id="hora_fim" name="hora_fim" type="number" min="1" max="24" defaultValue={horario.hora_fim} />
                <ErroCampo msg={estado.errosCampo?.['hora_fim']} />
              </div>
            </div>
          </div>
        ) : null}
        <p className="text-xs text-muted-foreground">
          Fora desse horário o agente avisa que não há atendente e segue ajudando.
        </p>
      </fieldset>

      <div>
        <SubmitButton>Salvar transferência</SubmitButton>
      </div>
    </form>
  );
}
