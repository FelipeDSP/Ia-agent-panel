'use client';

import { useActionState } from 'react';

import { salvarVendas, type EstadoConfig } from '../acoes';
import { Alert } from '@/components/ui/alert';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SubmitButton } from '@/components/ui/submit-button';
import { Textarea } from '@/components/ui/textarea';
import { EVENTOS, MAX_ENDERECO, PAGAMENTOS, type ConfigVendas } from '@/lib/tools/vendas-config';

function ErroCampo({ msg }: { msg?: string }) {
  if (!msg) return null;
  return <p className="text-xs text-destructive">{msg}</p>;
}

const CHECK =
  'h-4 w-4 accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background';

/**
 * O que o cliente decide sobre vendas (migração 69): formas de pagar,
 * retirada e entrega. O aviso ao dono saiu daqui em 18/09 — mora em "Avisos
 * para você", junto com o da transferência.
 */
export function FormularioVendas({
  ativo,
  config,
  transferirDisponivel,
  linkDisponivel,
}: {
  ativo: boolean;
  config: ConfigVendas;
  transferirDisponivel: boolean;
  /** módulo `pagamento` (Asaas) contratado — sem ele "por link" nem existe no agente */
  linkDisponivel: boolean;
}) {
  const [estado, acao] = useActionState<EstadoConfig, FormData>(salvarVendas, {});

  return (
    <form action={acao} className="flex flex-col gap-5">
      {estado.erro ? <Alert variant="destructive">{estado.erro}</Alert> : null}
      {estado.sucesso ? <Alert variant="success">{estado.sucesso}</Alert> : null}

      {!ativo ? (
        <Alert>Desligado: o que você ajustar aqui só passa a valer quando ligar o módulo em “Meus módulos”.</Alert>
      ) : null}

      <fieldset className="flex flex-col gap-3 rounded-xl border border-border p-4">
        <legend className="px-1 text-sm font-medium">Como o cliente pode pagar</legend>
        {PAGAMENTOS.map((p) => {
          const indisponivel = p.valor === 'link' && !linkDisponivel;
          // sem o módulo de pagamento, o padrão do banco ("link") não faz sentido: a
          // tela propõe "na retirada" marcado, e o cliente salva o que vale
          const marcado = indisponivel ? false : (!linkDisponivel && p.valor === 'na_retirada' ? true : config.pagamentos.includes(p.valor));
          return (
            <label key={p.valor} className={`flex items-start gap-3 ${indisponivel ? 'text-muted-foreground' : ''}`}>
              <input
                type="checkbox"
                name={`pagamento_${p.valor}`}
                defaultChecked={marcado}
                disabled={indisponivel}
                className={`${CHECK} mt-0.5`}
              />
              <span className="flex flex-col">
                <span className="text-sm">{p.rotulo}</span>
                <span className="text-xs text-muted-foreground">
                  {indisponivel ? 'Exige o módulo de pagamento (Asaas) — fale com a agência.' : p.resumo}
                </span>
              </span>
            </label>
          );
        })}
        <ErroCampo msg={estado.errosCampo?.['pagamentos']} />
        <p className="text-xs text-muted-foreground">
          Com as duas marcadas, o agente pergunta ao cliente qual prefere antes de fechar.
        </p>
      </fieldset>

      <fieldset className="flex flex-col gap-3 rounded-xl border border-border p-4">
        <legend className="px-1 text-sm font-medium">Retirada</legend>
        <label className="flex items-start gap-3">
          <input type="checkbox" name="pedir_nome" defaultChecked={config.pedir_nome} className={`${CHECK} mt-0.5`} />
          <span className="flex flex-col">
            <span className="text-sm">Perguntar o nome de quem vai retirar</span>
            <span className="text-xs text-muted-foreground">
              O agente pergunta em nome de quem fica o pedido antes de fechar; o nome vai no aviso e em Pedidos.
            </span>
          </span>
        </label>
        <div className="flex flex-col gap-2">
          <Label htmlFor="endereco">Endereço de retirada</Label>
          <Textarea id="endereco" name="endereco" rows={2} maxLength={MAX_ENDERECO} defaultValue={config.retirada.endereco ?? ''} placeholder="Ex.: Av. Tancredo Neves, 1234 — Centro, Ariquemes. Seg a sex, 8h às 18h." />
          <p className="text-xs text-muted-foreground">
            Enviado ao cliente assim que o pedido fecha para retirada. Vazio = não envia.
          </p>
          <ErroCampo msg={estado.errosCampo?.['endereco']} />
        </div>
        <div className="flex max-w-md flex-col gap-2">
          <Label htmlFor="mapa_url">Link do mapa (opcional)</Label>
          <Input id="mapa_url" name="mapa_url" defaultValue={config.retirada.mapa_url ?? ''} placeholder="https://maps.app.goo.gl/…" />
          <ErroCampo msg={estado.errosCampo?.['mapa_url']} />
        </div>
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

      <div>
        <SubmitButton>Salvar vendas</SubmitButton>
      </div>
    </form>
  );
}
