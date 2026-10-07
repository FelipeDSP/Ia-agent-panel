'use client';

import { useActionState, useState } from 'react';

import { salvarHorarioAgente, type EstadoConfig } from '../acoes';
import { Alert } from '@/components/ui/alert';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { SubmitButton } from '@/components/ui/submit-button';
import { Textarea } from '@/components/ui/textarea';
import {
  DIAS_SEMANA, MAX_JANELAS, MAX_MENSAGEM, POSTURAS, TIMEZONES_BR, datasParaExibir,
  type HorarioAgente, type JanelaPainel,
} from '@/lib/tenants/horario-agente';

function ErroCampo({ msg }: { msg?: string }) {
  if (!msg) return null;
  return <p className="text-xs text-destructive">{msg}</p>;
}

const CHECK =
  'h-4 w-4 accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background';

/**
 * Horário de atendimento do agente (74). Desligado = sempre aberto, que é o
 * comportamento de sempre; ligado, o cliente diz quando abre, quais datas
 * fecha e o que o agente faz fora disso.
 */
export function FormularioHorario({ horario }: { horario: HorarioAgente | null }) {
  const [estado, acao] = useActionState<EstadoConfig, FormData>(salvarHorarioAgente, {});
  const [ativo, setAtivo] = useState(horario !== null);
  const h: HorarioAgente = horario ?? {
    timezone: 'America/Sao_Paulo', dias_semana: [1, 2, 3, 4, 5], hora_inicio: 8, hora_fim: 18,
    janelas: [{ dias: [1, 2, 3, 4, 5], inicio: '08:00', fim: '18:00' }],
    fechados: [], fora_horario: 'aviso',
  };

  /*
   * 07/10 — as faixas. Nasceu do Empório, que abre ter–sex das 7h às 10h E das
   * 16h às 19h: com um "abre às / fecha às" só, o que estava gravado era
   * 7h–19h, e às 12h de uma quarta o agente dizia "estamos abertos".
   *
   * Vai ao servidor como UM campo JSON, não como `janela_0_inicio`: índice em
   * nome de campo quebra assim que alguém remove a faixa do meio, e o bug
   * aparece como dado trocado, não como erro.
   */
  const [janelas, setJanelas] = useState<JanelaPainel[]>(h.janelas);
  const mexer = (i: number, troca: Partial<JanelaPainel>) =>
    setJanelas((js) => js.map((j, k) => (k === i ? { ...j, ...troca } : j)));
  const viraDia = (i: number, dia: number) =>
    mexer(i, { dias: janelas[i]!.dias.includes(dia) ? janelas[i]!.dias.filter((d) => d !== dia) : [...janelas[i]!.dias, dia].sort((a, b) => a - b) });

  return (
    <form action={acao} className="flex flex-col gap-5">
      {estado.erro ? <Alert variant="destructive">{estado.erro}</Alert> : null}
      {estado.sucesso ? <Alert variant="success">{estado.sucesso}</Alert> : null}

      <label className="flex items-center gap-3">
        <input type="checkbox" name="horario_ativo" checked={ativo} onChange={(e) => setAtivo(e.target.checked)} className={CHECK} />
        <span className="text-sm">Ter horário de atendimento</span>
      </label>
      {!ativo ? (
        <p className="text-xs text-muted-foreground">Sem horário, o agente atende a qualquer hora, todos os dias.</p>
      ) : null}

      <fieldset disabled={!ativo} className="flex flex-col gap-4 rounded-xl border border-border p-4 disabled:opacity-50">
        <legend className="px-1 text-sm font-medium">Quando a loja atende</legend>

        <div className="flex max-w-xs flex-col gap-2">
          <Label htmlFor="h_timezone">Fuso horário</Label>
          <Select id="h_timezone" name="timezone" defaultValue={h.timezone}>
            {TIMEZONES_BR.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
          </Select>
          <ErroCampo msg={estado.errosCampo?.['timezone']} />
        </div>

        <input type="hidden" name="janelas" value={JSON.stringify(janelas)} />

        <div className="flex flex-col gap-3">
          <span className="text-sm font-medium">Faixas de atendimento</span>
          <p className="text-xs text-muted-foreground">
            Uma faixa por período em que a loja atende. Quem fecha para o almoço, ou abre
            de manhã e de tarde, usa duas faixas nos mesmos dias.
          </p>

          {janelas.map((j, i) => (
            <div key={i} className="flex flex-col gap-3 rounded-lg border border-border bg-muted/30 p-3">
              <div className="flex flex-wrap gap-x-3 gap-y-2">
                {DIAS_SEMANA.map((d) => (
                  <label key={d.valor} className="flex items-center gap-1.5 text-sm">
                    <input type="checkbox" checked={j.dias.includes(d.valor)} onChange={() => viraDia(i, d.valor)} className={CHECK} />
                    {d.nome}
                  </label>
                ))}
              </div>
              <div className="flex flex-wrap items-end gap-3">
                <div className="flex w-28 flex-col gap-1.5">
                  <Label htmlFor={`j_${i}_ini`}>Abre às</Label>
                  <Input id={`j_${i}_ini`} type="time" value={j.inicio} onChange={(e) => mexer(i, { inicio: e.target.value })} />
                </div>
                <div className="flex w-28 flex-col gap-1.5">
                  <Label htmlFor={`j_${i}_fim`}>Fecha às</Label>
                  <Input id={`j_${i}_fim`} type="time" value={j.fim} onChange={(e) => mexer(i, { fim: e.target.value })} />
                </div>
                {/* A última faixa não tem "Remover": sem nenhuma, o servidor
                    recusa o save, e um botão que leva a um erro é uma armadilha. */}
                {janelas.length > 1 ? (
                  <button
                    type="button"
                    onClick={() => setJanelas((js) => js.filter((_, k) => k !== i))}
                    className="h-9 rounded-md px-2 text-sm text-muted-foreground underline-offset-4 hover:text-destructive hover:underline"
                  >
                    Remover
                  </button>
                ) : null}
              </div>
            </div>
          ))}

          {janelas.length < MAX_JANELAS ? (
            <button
              type="button"
              onClick={() => setJanelas((js) => [...js, { dias: js[js.length - 1]?.dias ?? [1, 2, 3, 4, 5], inicio: '16:00', fim: '19:00' }])}
              className="self-start rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted"
            >
              Adicionar faixa
            </button>
          ) : null}
          <ErroCampo msg={estado.errosCampo?.['janelas']} />
          <ErroCampo msg={estado.errosCampo?.['dias_semana']} />
          <ErroCampo msg={estado.errosCampo?.['hora_inicio']} />
          <ErroCampo msg={estado.errosCampo?.['hora_fim']} />
        </div>

        <div className="flex max-w-xs flex-col gap-2">
          <Label htmlFor="h_fechados">Datas fechadas (feriados)</Label>
          <Textarea id="h_fechados" name="fechados" rows={3} defaultValue={datasParaExibir(h.fechados)} placeholder={'25/12/2026\n01/01/2027'} />
          <p className="text-xs text-muted-foreground">Uma data por linha, DD/MM/AAAA. Vale para o dia inteiro.</p>
          <ErroCampo msg={estado.errosCampo?.['fechados']} />
        </div>
      </fieldset>

      <fieldset disabled={!ativo} className="flex flex-col gap-3 rounded-xl border border-border p-4 disabled:opacity-50">
        <legend className="px-1 text-sm font-medium">Fora do horário, o agente…</legend>
        {POSTURAS.map((p) => (
          <label key={p.valor} className="flex items-start gap-3">
            <input type="radio" name="fora_horario" value={p.valor} defaultChecked={h.fora_horario === p.valor} className={`${CHECK} mt-0.5`} />
            <span className="flex flex-col">
              <span className="text-sm">{p.rotulo}</span>
              <span className="text-xs text-muted-foreground">{p.resumo}</span>
            </span>
          </label>
        ))}
        <div className="flex flex-col gap-2">
          <Label htmlFor="h_mensagem">Mensagem de fechado (opcional)</Label>
          <Textarea id="h_mensagem" name="mensagem" rows={2} maxLength={MAX_MENSAGEM} defaultValue={h.mensagem ?? ''} placeholder="Ex.: Estamos fechados agora. Voltamos {proxima} — deixe sua mensagem que respondemos assim que abrir!" />
          <p className="text-xs text-muted-foreground">
            Vazio = texto padrão com a próxima abertura. Escreva <code>{'{proxima}'}</code> para inserir quando a loja abre.
          </p>
          <ErroCampo msg={estado.errosCampo?.['mensagem']} />
        </div>
      </fieldset>

      <div>
        <SubmitButton>Salvar horário</SubmitButton>
      </div>
    </form>
  );
}
