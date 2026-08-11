'use client';

import { useState, useTransition } from 'react';

import { alternarModulo } from '../acoes';
import { Alert } from '@/components/ui/alert';
import { Switch } from '@/components/ui/switch';

export type ModuloItem = {
  tool_nome: string;
  rotulo: string;
  resumo: string;
  ativo: boolean;
  temConfigCliente: boolean;
};

/**
 * "Meus módulos" com liga/desliga por módulo.
 *
 * Antes o card só exibia badge de estado, e o único lugar que gravava `ativo`
 * era o formulário da transferência — módulo sem config de cliente ficava preso
 * em desligado. O switch aqui é o ÚNICO escritor de `tenant_tools.ativo` pelo
 * lado do cliente.
 *
 * O estado local existe só para o otimismo visual; a verdade vem do servidor no
 * revalidate. Se a ação falhar, voltamos ao valor anterior e mostramos o erro —
 * switch que fica ligado sobre um update que não gravou é pior que erro visível.
 */
export function ListaModulos({ modulos }: { modulos: ModuloItem[] }) {
  const [pendente, startTransition] = useTransition();
  const [estado, setEstado] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(modulos.map((m) => [m.tool_nome, m.ativo])),
  );
  const [erro, setErro] = useState<string | null>(null);
  const [emVoo, setEmVoo] = useState<string | null>(null);

  function alternar(toolNome: string, proximo: boolean) {
    setErro(null);
    setEmVoo(toolNome);
    setEstado((s) => ({ ...s, [toolNome]: proximo }));

    startTransition(async () => {
      const r = await alternarModulo(toolNome, proximo);
      if (!r.ok) {
        setEstado((s) => ({ ...s, [toolNome]: !proximo }));
        setErro(r.erro);
      }
      setEmVoo(null);
    });
  }

  if (modulos.length === 0) {
    return <p className="text-sm text-muted-foreground">Nenhum módulo contratado ainda.</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      {erro ? <Alert variant="destructive">{erro}</Alert> : null}

      <div className="flex flex-col divide-y divide-border">
        {modulos.map((m) => {
          const ligado = estado[m.tool_nome] ?? false;
          return (
            <div
              key={m.tool_nome}
              className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
            >
              <div className="min-w-0">
                <label
                  htmlFor={`modulo-${m.tool_nome}`}
                  className="cursor-pointer font-medium"
                >
                  {m.rotulo}
                </label>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {m.resumo}
                  {m.temConfigCliente ? ' Ajuste os detalhes abaixo.' : ''}
                </p>
              </div>

              <div className="flex items-center gap-3">
                <span
                  className={
                    ligado ? 'text-xs text-muted-foreground' : 'text-xs text-muted-foreground/70'
                  }
                >
                  {ligado ? 'ativo' : 'desligado'}
                </span>
                <Switch
                  id={`modulo-${m.tool_nome}`}
                  checked={ligado}
                  onCheckedChange={(proximo) => alternar(m.tool_nome, proximo)}
                  disabled={pendente && emVoo === m.tool_nome}
                  aria-label={`${ligado ? 'Desligar' : 'Ligar'} ${m.rotulo}`}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
