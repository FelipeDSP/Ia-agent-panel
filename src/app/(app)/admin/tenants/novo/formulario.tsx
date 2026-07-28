'use client';

import { useActionState } from 'react';

import { criarTenant, type EstadoAcao } from '../../acoes';
import { Alert } from '@/components/ui/alert';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { SubmitButton } from '@/components/ui/submit-button';
import { Textarea } from '@/components/ui/textarea';
import { MODELOS_PERMITIDOS } from '@/lib/tenants/schema';

function ErroCampo({ msg }: { msg?: string }) {
  if (!msg) return null;
  return <p className="text-xs text-destructive">{msg}</p>;
}

export function FormularioNovoTenant() {
  const [estado, acao] = useActionState<EstadoAcao, FormData>(criarTenant, {});

  return (
    <form action={acao} className="flex flex-col gap-5">
      {estado.erro ? <Alert variant="destructive">{estado.erro}</Alert> : null}
      {estado.sucesso ? <Alert variant="success">{estado.sucesso}</Alert> : null}

      <div className="flex flex-col gap-2">
        <Label htmlFor="nome">Nome do cliente</Label>
        <Input id="nome" name="nome" required autoFocus />
        <ErroCampo msg={estado.errosCampo?.['nome']} />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="slug">Slug</Label>
        <Input id="slug" name="slug" placeholder="deixe vazio para gerar do nome" />
        <p className="text-xs text-muted-foreground">
          Identificador em minúsculas. Se vazio, é gerado a partir do nome.
        </p>
        <ErroCampo msg={estado.errosCampo?.['slug']} />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="system_prompt">Prompt inicial</Label>
        <Textarea
          id="system_prompt"
          name="system_prompt"
          rows={6}
          placeholder="Você é a assistente virtual da empresa X…"
        />
        <p className="text-xs text-muted-foreground">
          Pode editar depois; o cliente também poderá, com histórico.
        </p>
      </div>

      <div className="grid gap-5 sm:grid-cols-3">
        <div className="flex flex-col gap-2">
          <Label htmlFor="modelo">Modelo</Label>
          <Select id="modelo" name="modelo" defaultValue="gpt-4.1-mini">
            {MODELOS_PERMITIDOS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </Select>
          <ErroCampo msg={estado.errosCampo?.['modelo']} />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="temperatura">Temperatura</Label>
          <Input
            id="temperatura"
            name="temperatura"
            type="number"
            step="0.05"
            min="0"
            max="2"
            defaultValue="0.30"
          />
          <ErroCampo msg={estado.errosCampo?.['temperatura']} />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="debounce_segundos">Debounce (s)</Label>
          <Input
            id="debounce_segundos"
            name="debounce_segundos"
            type="number"
            min="1"
            max="60"
            defaultValue="8"
          />
          <ErroCampo msg={estado.errosCampo?.['debounce_segundos']} />
        </div>
      </div>

      <div className="flex gap-3">
        <SubmitButton pendingLabel="Criando…">Criar cliente</SubmitButton>
      </div>

      <p className="text-xs text-muted-foreground">
        O cliente é criado sem conexão ao Chatwoot. Conecte e convide o admin na
        página do cliente.
      </p>
    </form>
  );
}
