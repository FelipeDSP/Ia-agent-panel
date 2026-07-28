'use client';

import { useActionState } from 'react';

import { adicionarPreco, type EstadoPreco } from './acoes';
import { Alert } from '@/components/ui/alert';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SubmitButton } from '@/components/ui/submit-button';

/**
 * Adiciona uma nova vigência de preço. Preços são config, não hardcode: mudou
 * na OpenAI, a agência registra a nova vigência aqui e o histórico anterior
 * continua calculado com o preço da época.
 */
export function FormularioPreco() {
  const [estado, acao] = useActionState<EstadoPreco, FormData>(adicionarPreco, {});

  return (
    <form action={acao} className="flex flex-col gap-4">
      {estado.erro ? <Alert variant="destructive">{estado.erro}</Alert> : null}
      {estado.sucesso ? <Alert variant="success">{estado.sucesso}</Alert> : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor="modelo">Modelo</Label>
          <Input id="modelo" name="modelo" placeholder="gpt-4.1-mini" required />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="vigente_desde">Vigente desde</Label>
          <Input id="vigente_desde" name="vigente_desde" type="date" required />
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="flex flex-col gap-2">
          <Label htmlFor="usd_entrada_por_1m">USD entrada / 1M</Label>
          <Input id="usd_entrada_por_1m" name="usd_entrada_por_1m" inputMode="decimal" placeholder="0.40" />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="usd_saida_por_1m">USD saída / 1M</Label>
          <Input id="usd_saida_por_1m" name="usd_saida_por_1m" inputMode="decimal" placeholder="1.60" />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="usd_embedding_por_1m">USD embedding / 1M</Label>
          <Input id="usd_embedding_por_1m" name="usd_embedding_por_1m" inputMode="decimal" placeholder="0.02" />
        </div>
      </div>

      <div>
        <SubmitButton>Registrar preço</SubmitButton>
      </div>
    </form>
  );
}
