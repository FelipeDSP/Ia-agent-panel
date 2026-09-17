'use client';

import { useActionState, useState } from 'react';

import { salvarVendas, type EstadoConfig } from '../acoes';
import { Alert } from '@/components/ui/alert';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SubmitButton } from '@/components/ui/submit-button';
import { EVENTOS, PAGAMENTOS, type ConfigVendas } from '@/lib/tools/vendas-config';

function ErroCampo({ msg }: { msg?: string }) {
  if (!msg) return null;
  return <p className="text-xs text-destructive">{msg}</p>;
}

const CHECK =
  'h-4 w-4 accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background';

/**
 * O que o cliente decide sobre vendas (migração 69). Espelha o formulário da
 * transferência. O aviso por WhatsApp sai pela inbox do próprio agente (70),
 * então não depende de sessão nenhuma — só do número.
 */
export function FormularioVendas({
  ativo,
  config,
  destinoNumero,
  transferirDisponivel,
}: {
  ativo: boolean;
  config: ConfigVendas;
  destinoNumero: string;
  transferirDisponivel: boolean;
}) {
  const [estado, acao] = useActionState<EstadoConfig, FormData>(salvarVendas, {});
  const [notificar, setNotificar] = useState(config.notificacao.canal !== 'nenhum');

  return (
    <form action={acao} className="flex flex-col gap-5">
      {estado.erro ? <Alert variant="destructive">{estado.erro}</Alert> : null}
      {estado.sucesso ? <Alert variant="success">{estado.sucesso}</Alert> : null}

      {!ativo ? (
        <Alert>Desligado: o que você ajustar aqui só passa a valer quando ligar o módulo em “Meus módulos”.</Alert>
      ) : null}

      <fieldset className="flex flex-col gap-3 rounded-xl border border-border p-4">
        <legend className="px-1 text-sm font-medium">Como o cliente pode pagar</legend>
        {PAGAMENTOS.map((p) => (
          <label key={p.valor} className="flex items-start gap-3">
            <input
              type="checkbox"
              name={`pagamento_${p.valor}`}
              defaultChecked={config.pagamentos.includes(p.valor)}
              className={`${CHECK} mt-0.5`}
            />
            <span className="flex flex-col">
              <span className="text-sm">{p.rotulo}</span>
              <span className="text-xs text-muted-foreground">{p.resumo}</span>
            </span>
          </label>
        ))}
        <ErroCampo msg={estado.errosCampo?.['pagamentos']} />
        <p className="text-xs text-muted-foreground">
          Com as duas marcadas, o agente pergunta ao cliente qual prefere antes de fechar.
        </p>
      </fieldset>

      <fieldset className="flex flex-col gap-3 rounded-xl border border-border p-4">
        <legend className="px-1 text-sm font-medium">Pedidos para entrega</legend>
        <p className="text-xs text-muted-foreground">
          O agente fecha pedidos só para <strong>retirada no local</strong>. Quando alguém pede entrega:
        </p>
        <label className="flex items-center gap-3 text-sm">
          <input type="radio" name="entrega" value="nao" defaultChecked={config.entrega !== 'atendente'} className={CHECK} />
          Avisar que só há retirada
        </label>
        <label className={`flex items-center gap-3 text-sm ${transferirDisponivel ? '' : 'text-muted-foreground'}`}>
          <input
            type="radio"
            name="entrega"
            value="atendente"
            defaultChecked={config.entrega === 'atendente'}
            disabled={!transferirDisponivel}
            className={CHECK}
          />
          Passar a conversa para um atendente, com o pedido já montado
        </label>
        {!transferirDisponivel ? (
          <p className="text-xs text-muted-foreground">
            Para passar a um atendente, ligue a transferência para atendimento humano.
          </p>
        ) : null}
        <ErroCampo msg={estado.errosCampo?.['entrega']} />
      </fieldset>

      <fieldset className="flex flex-col gap-3 rounded-xl border border-border p-4">
        <legend className="px-1 text-sm font-medium">Aviso de venda</legend>

        <div className="flex flex-col gap-2">
          <span className="text-sm">Quando avisar</span>
          <div className="flex flex-wrap gap-4">
            {EVENTOS.map((e) => (
              <label key={e.valor} className="flex items-center gap-1.5 text-sm">
                <input type="checkbox" name={`evento_${e.valor}`} defaultChecked={config.eventos.includes(e.valor)} className={CHECK} />
                {e.rotulo}
              </label>
            ))}
          </div>
          <ErroCampo msg={estado.errosCampo?.['eventos']} />
        </div>

        <label className="flex items-center gap-3">
          <input type="checkbox" name="nota_chatwoot" defaultChecked={config.notificacao.nota_chatwoot === true} className={CHECK} />
          <span className="text-sm">Deixar uma nota privada na conversa do Chatwoot</span>
        </label>

        <label className="flex items-center gap-3">
          <input
            type="checkbox"
            name="notificar"
            checked={notificar}
            onChange={(e) => setNotificar(e.target.checked)}
            className={CHECK}
          />
          <span className="text-sm">Me avisar no WhatsApp</span>
        </label>
        <div className="flex max-w-xs flex-col gap-2">
          <Label htmlFor="destino_vendas">WhatsApp para aviso</Label>
          <Input id="destino_vendas" name="destino" placeholder="Ex.: 556993666645" defaultValue={destinoNumero} disabled={!notificar} />
          <p className="text-xs text-muted-foreground">
            O aviso chega pelo mesmo WhatsApp que atende seus clientes. Se não chegar, tente sem o 9 depois do DDD.
          </p>
          <ErroCampo msg={estado.errosCampo?.['destino']} />
        </div>
      </fieldset>

      <div>
        <SubmitButton>Salvar vendas</SubmitButton>
      </div>
    </form>
  );
}
