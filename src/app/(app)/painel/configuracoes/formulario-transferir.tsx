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

export function FormularioTransferir({
  ativo,
  horario,
  notificarAtual,
  destinoNumero,
  temSessao,
}: {
  ativo: boolean;
  horario: Horario;
  notificarAtual: boolean;
  destinoNumero: string;
  temSessao: boolean;
}) {
  const [estado, acao] = useActionState<EstadoConfig, FormData>(salvarTransferirHumano, {});
  const [notificar, setNotificar] = useState(notificarAtual);

  return (
    <form action={acao} className="flex flex-col gap-5">
      {estado.erro ? <Alert variant="destructive">{estado.erro}</Alert> : null}
      {estado.sucesso ? <Alert variant="success">{estado.sucesso}</Alert> : null}

      <label className="flex items-center gap-3">
        <input
          type="checkbox"
          name="ativo"
          defaultChecked={ativo}
          className="h-4 w-4 accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        />
        <span className="text-sm font-medium">Oferecer transferência para atendimento humano</span>
      </label>
      <p className="-mt-3 text-xs text-muted-foreground">
        Quando ligado, o agente pode passar a conversa para um atendente (dentro do horário) e
        pausa o bot naquela conversa.
      </p>

      <fieldset className="flex flex-col gap-4 rounded-xl border border-border p-4">
        <legend className="px-1 text-sm font-medium">Horário de atendimento</legend>

        <div className="flex max-w-xs flex-col gap-2">
          <Label htmlFor="timezone">Fuso horário</Label>
          <Select id="timezone" name="timezone" defaultValue={horario.timezone}>
            {TIMEZONES_BR.map((tz) => (
              <option key={tz} value={tz}>
                {tz}
              </option>
            ))}
          </Select>
          <ErroCampo msg={estado.errosCampo?.['timezone']} />
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">Dias</span>
          <div className="flex flex-wrap gap-3">
            {DIAS_SEMANA.map((d) => (
              <label key={d.valor} className="flex items-center gap-1.5 text-sm">
                <input
                  type="checkbox"
                  name={`dia_${d.valor}`}
                  defaultChecked={horario.dias_semana.includes(d.valor)}
                  className="h-4 w-4 accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                />
                {d.nome}
              </label>
            ))}
          </div>
          <ErroCampo msg={estado.errosCampo?.['dias_semana']} />
        </div>

        <div className="flex gap-4">
          <div className="flex w-28 flex-col gap-2">
            <Label htmlFor="hora_inicio">Abre às</Label>
            <Input
              id="hora_inicio"
              name="hora_inicio"
              type="number"
              min="0"
              max="23"
              defaultValue={horario.hora_inicio}
            />
            <ErroCampo msg={estado.errosCampo?.['hora_inicio']} />
          </div>
          <div className="flex w-28 flex-col gap-2">
            <Label htmlFor="hora_fim">Fecha às</Label>
            <Input
              id="hora_fim"
              name="hora_fim"
              type="number"
              min="1"
              max="24"
              defaultValue={horario.hora_fim}
            />
            <ErroCampo msg={estado.errosCampo?.['hora_fim']} />
          </div>
        </div>
        <p className="-mt-1 text-xs text-muted-foreground">
          Horas em 0–24 (ex.: abre 8, fecha 18). Fora desse horário o agente informa que não há
          atendente e segue ajudando.
        </p>
      </fieldset>

      <fieldset className="flex flex-col gap-3 rounded-xl border border-border p-4">
        <legend className="px-1 text-sm font-medium">Notificação</legend>

        {temSessao ? (
          <>
            <label className="flex items-center gap-3">
              <input
                type="checkbox"
                name="notificar"
                checked={notificar}
                onChange={(e) => setNotificar(e.target.checked)}
                className="h-4 w-4 accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              />
              <span className="text-sm">Me avisar no WhatsApp quando alguém pedir atendimento</span>
            </label>

            <div className="flex max-w-xs flex-col gap-2">
              <Label htmlFor="destino">WhatsApp para aviso</Label>
              <Input
                id="destino"
                name="destino"
                placeholder="Ex.: 556993666645"
                defaultValue={destinoNumero}
                disabled={!notificar}
              />
              <p className="text-xs text-muted-foreground">
                Número completo com o código do país (55). Digite exatamente como o número está no
                WhatsApp — no Brasil, alguns não têm o 9 depois do DDD. Se o aviso não chegar no
                teste, tente sem esse 9.
              </p>
              <ErroCampo msg={estado.errosCampo?.['destino']} />
            </div>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            O canal de aviso por WhatsApp ainda não foi configurado pela agência. Você já pode
            definir o horário; assim que o canal estiver pronto, o aviso aparece aqui.
          </p>
        )}
      </fieldset>

      <div>
        <SubmitButton>Salvar transferência</SubmitButton>
      </div>
    </form>
  );
}
