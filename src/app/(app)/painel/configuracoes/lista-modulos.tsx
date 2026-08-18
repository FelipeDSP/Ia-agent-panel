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
/**
 * Switch de UM módulo, isolado para ter UM ÚNICO escritor de `tenant_tools.ativo`
 * no lado do cliente.
 *
 * Existe separado porque a transferência para humano tem card próprio e o switch
 * dela mora lá, não na lista. Duplicar a lógica criaria dois escritores — o
 * problema que já aconteceu quando o formulário da transferência também gravava
 * `ativo`: salvar o horário revertia o switch em silêncio.
 *
 * `aviso` aparece só quando o módulo está LIGADO, porque é o texto que explica o
 * que se perde ao desligar.
 */
export function SwitchModulo({
  toolNome,
  rotulo,
  ativo,
  aviso,
}: {
  toolNome: string;
  rotulo: string;
  ativo: boolean;
  aviso?: string;
}) {
  const [pendente, startTransition] = useTransition();
  const [ligado, setLigado] = useState(ativo);
  const [erro, setErro] = useState<string | null>(null);

  function alternar(proximo: boolean) {
    setErro(null);
    setLigado(proximo);
    startTransition(async () => {
      const r = await alternarModulo(toolNome, proximo);
      if (!r.ok) {
        setLigado(!proximo);
        setErro(r.erro);
      }
    });
  }

  return (
    <div className="flex flex-col gap-2">
      {erro ? <Alert variant="destructive">{erro}</Alert> : null}
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/*
          O rótulo diz QUAL controle é; o switch já diz o estado. "Módulo ligado"
          ao lado de um switch verde é a mesma informação duas vezes, e a leitura
          custa mais que o switch.
        */}
        <label htmlFor={`switch-${toolNome}`} className="cursor-pointer text-sm font-medium">
          {rotulo}
        </label>
        <Switch
          id={`switch-${toolNome}`}
          checked={ligado}
          onCheckedChange={alternar}
          disabled={pendente}
          aria-label={`${ligado ? 'Desligar' : 'Ligar'} ${rotulo}`}
        />
      </div>
      {/*
        INVERTIDO: o aviso aparece com o módulo DESLIGADO, não ligado.
        Ligado, ele era uma hipótese ("se você desligar...") ocupando espaço
        permanente. Desligado, é o estado em que a pessoa está agora — e aí a
        consequência não é dedutível de um switch cinza.
      */}
      {!ligado && aviso ? <p className="text-xs text-muted-foreground">{aviso}</p> : null}
    </div>
  );
}

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
                {/*
                  O resumo só aparece no módulo DESLIGADO. Quem contratou e está
                  com o módulo no ar já sabe o que ele faz; repetir a descrição
                  em toda visita é o texto que o cliente pula. Desligado, o
                  resumo é o que responde "o que eu ganho ligando isto?".
                */}
                {!ligado ? (
                  <p className="mt-0.5 text-xs text-muted-foreground">{m.resumo}</p>
                ) : null}
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
