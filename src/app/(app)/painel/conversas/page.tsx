import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { exigirTenantAdmin } from '@/lib/auth';
import { criarClienteServidor } from '@/lib/supabase/server';

import { ListaConversas } from './lista';

export default async function PaginaConversas() {
  const usuario = await exigirTenantAdmin();
  const supabase = await criarClienteServidor();

  // RLS ja escopa por tenant; filtro explicito por tenant_id como segunda camada.
  const { data: conversas } = await supabase
    .from('conversas')
    .select('conversation_id, contact_name, phone, status, atualizado_em')
    .eq('tenant_id', usuario.tenantId)
    .order('atualizado_em', { ascending: false })
    .limit(200);

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Conversas</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Acompanhe o atendimento do agente. Abra uma conversa para ver o histórico ou
          pausar o agente nela.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Atendimentos</CardTitle>
          <CardDescription>
            Limpar a memória faz o agente esquecer o contexto daquela conversa e voltar a
            consultar a base de conhecimento — útil depois de atualizar a base. Não apaga o
            histórico exibido aqui.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {conversas && conversas.length > 0 ? (
            <ListaConversas conversas={conversas} />
          ) : (
            <p className="text-sm text-muted-foreground">Nenhuma conversa ainda.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
