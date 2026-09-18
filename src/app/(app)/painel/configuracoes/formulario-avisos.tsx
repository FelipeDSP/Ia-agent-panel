'use client';

import { useActionState, useState } from 'react';

import { salvarAvisos, type EstadoConfig } from '../acoes';
import { Alert } from '@/components/ui/alert';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SubmitButton } from '@/components/ui/submit-button';
import type { Avisos } from '@/lib/tools/avisos';
import { EVENTOS } from '@/lib/tools/vendas-config';

function ErroCampo({ msg }: { msg?: string }) {
  if (!msg) return null;
  return <p className="text-xs text-destructive">{msg}</p>;
}

const CHECK =
  'h-4 w-4 accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background';

/** "Avisos para você" (18/09): um número, uma lista do que avisar. */
export function FormularioAvisos({ avisos, temTransferencia, temVendas }: { avisos: Avisos; temTransferencia: boolean; temVendas: boolean }) {
  const [estado, acao] = useActionState<EstadoConfig, FormData>(salvarAvisos, {});
  const [whatsapp, setWhatsapp] = useState(avisos.whatsapp);

  return (
    <form action={acao} className="flex flex-col gap-5">
      {estado.erro ? <Alert variant="destructive">{estado.erro}</Alert> : null}
      {estado.sucesso ? <Alert variant="success">{estado.sucesso}</Alert> : null}

      <div className="flex flex-col gap-3">
        <label className="flex items-center gap-3">
          <input type="checkbox" name="whatsapp" checked={whatsapp} onChange={(e) => setWhatsapp(e.target.checked)} className={CHECK} />
          <span className="text-sm">Me avisar no WhatsApp</span>
        </label>
        <div className="flex max-w-xs flex-col gap-2">
          <Label htmlFor="destino">Seu WhatsApp</Label>
          <Input id="destino" name="destino" placeholder="Ex.: 556993666645" defaultValue={avisos.numero} disabled={!whatsapp} />
          <p className="text-xs text-muted-foreground">
            O aviso chega pelo mesmo WhatsApp que atende seus clientes. Se não chegar, tente sem o 9 depois do DDD.
          </p>
          <ErroCampo msg={estado.errosCampo?.['destino']} />
        </div>
      </div>

      <fieldset className="flex flex-col gap-3 rounded-xl border border-border p-4">
        <legend className="px-1 text-sm font-medium">Avisar quando…</legend>
        {temTransferencia ? (
          <label className="flex items-center gap-3 text-sm">
            <input type="checkbox" name="aviso_transferencia" defaultChecked={avisos.transferencia} className={CHECK} />
            alguém pedir atendimento humano
          </label>
        ) : null}
        {temVendas ? EVENTOS.map((e) => (
          <label key={e.valor} className="flex items-center gap-3 text-sm">
            <input type="checkbox" name={`evento_${e.valor}`} defaultChecked={avisos.eventos.includes(e.valor)} className={CHECK} />
            {e.rotulo.toLowerCase()}
          </label>
        )) : null}
        <ErroCampo msg={estado.errosCampo?.['whatsapp']} />
        {temVendas ? (
          <label className="mt-1 flex items-center gap-3 border-t border-border pt-3 text-sm">
            <input type="checkbox" name="nota_chatwoot" defaultChecked={avisos.nota_chatwoot} className={CHECK} />
            Também deixar uma nota privada na conversa do Chatwoot a cada venda
          </label>
        ) : null}
      </fieldset>

      <div>
        <SubmitButton>Salvar avisos</SubmitButton>
      </div>
    </form>
  );
}
