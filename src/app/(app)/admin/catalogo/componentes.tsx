'use client';

import { useActionState } from 'react';

import { definirVisibilidadeTool, type EstadoAcao } from '../acoes';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { SubmitButton } from '@/components/ui/submit-button';

export type ToolCatalogo = {
  tool_nome: string;
  rotulo: string;
  resumo: string;
  tipo: 'tool_modelo' | 'capacidade_fluxo';
  baseline: boolean;
  contratavel: boolean;
  desligavel: boolean;
  temConfigCliente: boolean;
  rotas: string[];
  noBanco: boolean;
  ativo: boolean;
  emUso: number;
};

export function ListaCatalogo({ tools }: { tools: ToolCatalogo[] }) {
  return (
    <ul className="divide-y">
      {tools.map((t) => <ToolItem key={t.tool_nome} tool={t} />)}
    </ul>
  );
}

/**
 * Uma tool, como o código a descreve. O único controle é ocultar/mostrar
 * (`catalogo_tools.ativo`); o resto é leitura — mudar rótulo, resumo ou
 * comportamento é mudar o registry ou a tool em `agente/`.
 */
function ToolItem({ tool }: { tool: ToolCatalogo }) {
  const [estado, acao] = useActionState<EstadoAcao, FormData>(definirVisibilidadeTool, {});
  return (
    <li className="flex flex-col gap-2 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{tool.rotulo}</span>
        <code className="text-xs text-muted-foreground">{tool.tool_nome}</code>
        <Badge variant="outline">{tool.tipo === 'capacidade_fluxo' ? 'etapa do fluxo' : 'tool do modelo'}</Badge>
        {tool.baseline ? <Badge variant="secondary">padrão de todo cliente</Badge> : null}
        {tool.contratavel ? <Badge variant="secondary">vendida</Badge> : null}
        {tool.desligavel ? <Badge variant="secondary">cliente pode desligar</Badge> : null}
        {tool.temConfigCliente ? <Badge variant="secondary">com configuração</Badge> : null}
        {!tool.noBanco ? <Badge variant="danger">sem linha no banco</Badge> : tool.ativo ? <Badge variant="success">em circulação</Badge> : <Badge variant="warning">oculta</Badge>}
      </div>
      <p className="text-sm text-muted-foreground">{tool.resumo}</p>
      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <span>{tool.emUso} cliente(s) com contrato</span>
        {tool.rotas.length ? <span>superfície no painel: {tool.rotas.join(', ')}</span> : null}
      </div>
      {tool.noBanco ? (
        <form action={acao} className="flex items-center gap-3">
          <input type="hidden" name="tool_nome" value={tool.tool_nome} />
          <input type="hidden" name="ativo" value={tool.ativo ? 'false' : 'true'} />
          <SubmitButton variant="outline" size="sm" pendingLabel="…">
            {tool.ativo ? 'Ocultar da oferta' : 'Voltar a oferecer'}
          </SubmitButton>
          {estado.erro ? <Alert variant="destructive">{estado.erro}</Alert> : null}
          {estado.sucesso ? <span className="text-xs text-success">{estado.sucesso}</span> : null}
        </form>
      ) : null}
    </li>
  );
}
