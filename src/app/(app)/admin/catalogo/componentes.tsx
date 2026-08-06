'use client';

import { useActionState, useState } from 'react';

import { criarToolCatalogo, editarToolCatalogo, type EstadoAcao } from '../acoes';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SubmitButton } from '@/components/ui/submit-button';
import { Textarea } from '@/components/ui/textarea';

function ErroCampo({ msg }: { msg?: string }) {
  if (!msg) return null;
  return <p className="text-xs text-destructive">{msg}</p>;
}

export type ToolCatalogo = {
  tool_nome: string;
  nome_exibicao: string;
  descricao_padrao: string | null;
  workflow_id_padrao: string | null;
  schema_config: unknown;
  ativo: boolean;
  emUso: number;
};

// Campos compartilhados por criar/editar (menos tool_nome, imutável no editar).
function CamposTool({
  prefixo,
  tool,
  erros,
}: {
  prefixo: string;
  tool?: ToolCatalogo;
  erros?: Record<string, string>;
}) {
  const schemaTexto =
    tool && tool.schema_config && Object.keys(tool.schema_config as object).length > 0
      ? JSON.stringify(tool.schema_config, null, 2)
      : '';
  return (
    <>
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${prefixo}-nome_exibicao`}>Nome de exibição</Label>
        <Input
          id={`${prefixo}-nome_exibicao`}
          name="nome_exibicao"
          defaultValue={tool?.nome_exibicao ?? ''}
          placeholder="Agendar horário"
        />
        <ErroCampo msg={erros?.['nome_exibicao']} />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor={`${prefixo}-descricao_padrao`}>Descrição padrão (ensina a IA quando usar)</Label>
        <Textarea
          id={`${prefixo}-descricao_padrao`}
          name="descricao_padrao"
          defaultValue={tool?.descricao_padrao ?? ''}
          rows={2}
          placeholder="Use quando o cliente pedir para marcar um horário."
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor={`${prefixo}-workflow_id_padrao`}>workflow_id padrão (sub-workflow no n8n)</Label>
        <Input
          id={`${prefixo}-workflow_id_padrao`}
          name="workflow_id_padrao"
          defaultValue={tool?.workflow_id_padrao ?? ''}
          placeholder="opcional — nós dedicados (busca/transferir) deixam vazio"
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor={`${prefixo}-schema_config`}>schema_config (JSON — opcional)</Label>
        <Textarea
          id={`${prefixo}-schema_config`}
          name="schema_config"
          defaultValue={schemaTexto}
          rows={4}
          className="font-mono text-xs"
          placeholder='{"campos_cliente":["horario"]}'
        />
        <ErroCampo msg={erros?.['schema_config']} />
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          name="ativo"
          defaultChecked={tool?.ativo ?? true}
          className="accent-primary"
        />
        Oferecível no catálogo (a agência pode contratar para clientes)
      </label>
    </>
  );
}

export function FormNovaTool() {
  const [estado, acao] = useActionState<EstadoAcao, FormData>(criarToolCatalogo, {});
  return (
    <form action={acao} className="flex flex-col gap-4">
      {estado.erro ? <Alert variant="destructive">{estado.erro}</Alert> : null}
      {estado.sucesso ? <Alert variant="success">{estado.sucesso}</Alert> : null}

      <div className="flex flex-col gap-2">
        <Label htmlFor="novo-tool_nome">tool_nome (identificador, imutável)</Label>
        <Input id="novo-tool_nome" name="tool_nome" placeholder="agendar_horario" className="font-mono" />
        <ErroCampo msg={estado.errosCampo?.['tool_nome']} />
      </div>

      <CamposTool prefixo="novo" erros={estado.errosCampo} />

      <div>
        <SubmitButton pendingLabel="Criando…">Criar tool</SubmitButton>
      </div>
    </form>
  );
}

export function ListaCatalogo({ tools }: { tools: ToolCatalogo[] }) {
  if (tools.length === 0) {
    return <p className="text-sm text-muted-foreground">Nenhuma tool no catálogo ainda.</p>;
  }
  return (
    <div className="flex flex-col divide-y divide-border">
      {tools.map((t) => (
        <ToolItem key={t.tool_nome} tool={t} />
      ))}
    </div>
  );
}

function ToolItem({ tool }: { tool: ToolCatalogo }) {
  const [editando, setEditando] = useState(false);
  const [estado, acao] = useActionState<EstadoAcao, FormData>(editarToolCatalogo, {});

  return (
    <div className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{tool.nome_exibicao}</span>
            <code className="text-xs text-muted-foreground">{tool.tool_nome}</code>
            <Badge variant={tool.ativo ? 'success' : 'secondary'}>
              {tool.ativo ? 'oferecível' : 'oculta'}
            </Badge>
            {tool.emUso > 0 ? (
              <Badge variant="secondary">{tool.emUso} cliente(s)</Badge>
            ) : null}
          </div>
          {tool.descricao_padrao ? (
            <p className="mt-0.5 text-xs text-muted-foreground">{tool.descricao_padrao}</p>
          ) : null}
        </div>
        <Button variant="outline" size="sm" onClick={() => setEditando((v) => !v)}>
          {editando ? 'Cancelar' : 'Editar'}
        </Button>
      </div>

      {editando ? (
        <form action={acao} className="flex flex-col gap-4 rounded-xl border border-border p-4">
          <input type="hidden" name="tool_nome" value={tool.tool_nome} />
          {estado.erro ? <Alert variant="destructive">{estado.erro}</Alert> : null}
          {estado.sucesso ? <Alert variant="success">{estado.sucesso}</Alert> : null}
          <CamposTool prefixo={`edit-${tool.tool_nome}`} tool={tool} erros={estado.errosCampo} />
          <div>
            <SubmitButton pendingLabel="Salvando…">Salvar</SubmitButton>
          </div>
        </form>
      ) : null}
    </div>
  );
}
