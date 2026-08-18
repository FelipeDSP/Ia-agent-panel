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

      {/* Ligar/desligar mora no switch de "Meus módulos" — um escritor só para
          tenant_tools.ativo. Aqui fica só o aviso de estado, para o cliente não
          configurar horário achando que o módulo já está no ar. */}
      {ativo ? (
        <>
          {/* "Módulo ligado. O agente pode passar a conversa..." saiu daqui: o
              switch logo acima já mostra o estado, e o resto descrevia o que o
              módulo faz para quem acabou de ligá-lo.

              O aviso abaixo FICA, e é o único dos três que fica: sem canal de
              aviso, transferir é silencioso — o bot pausa e sobra a nota privada
              no Chatwoot. Como o módulo entra ligado por padrão, o cliente pode
              nunca ter escolhido isso, e não há nada na tela de onde deduzir. */}
          {!notificarAtual ? (
            <Alert>
              <strong>Você não recebe aviso quando alguém pede atendimento.</strong> A conversa é
              pausada e fica marcada no <strong>Chatwoot</strong> — é lá que você acompanha e
              responde. Ninguém é notificado por WhatsApp.
              {temSessao ? (
                <> Para receber aviso, ligue a notificação abaixo e informe o número.</>
              ) : (
                <> Se quiser aviso no WhatsApp, fale com a agência: o canal ainda não foi
                  configurado para você.</>
              )}
            </Alert>
          ) : null}
        </>
      ) : (
        /*
         * FICA, encurtado — e com um defeito de conteúdo corrigido: mandava
         * ligar em "Meus módulos", mas o switch deste módulo vive NESTE card,
         * logo acima. O texto apontava para o lugar errado.
         *
         * A consequência que sobra não é dedutível: dá para configurar tudo
         * aqui e nada valer até o switch subir.
         */
        <Alert>
          Desligado: o que você ajustar aqui só passa a valer quando ligar o botão acima.
        </Alert>
      )}

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
              placeholder="8"
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
              placeholder="18"
              defaultValue={horario.hora_fim}
            />
            <ErroCampo msg={estado.errosCampo?.['hora_fim']} />
          </div>
        </div>
        {/* O FORMATO virou placeholder (8 e 18) e min/max do campo. Sobra a
            consequência, que é o que ninguém deduz olhando dois campos de hora. */}
        <p className="-mt-1 text-xs text-muted-foreground">
          Fora desse horário o agente avisa que não há atendente e segue ajudando.
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
              {/* O formato está no placeholder. Sobra a regra do 9, que é
                  armadilha real e não se deduz de lugar nenhum — mas cabe em
                  uma linha em vez de três. */}
              <p className="text-xs text-muted-foreground">
                Se o aviso não chegar, tente sem o 9 depois do DDD.
              </p>
              <ErroCampo msg={estado.errosCampo?.['destino']} />
            </div>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            O aviso por WhatsApp ainda não foi configurado pela agência — o horário acima já vale.
          </p>
        )}
      </fieldset>

      <div>
        <SubmitButton>Salvar transferência</SubmitButton>
      </div>
    </form>
  );
}
