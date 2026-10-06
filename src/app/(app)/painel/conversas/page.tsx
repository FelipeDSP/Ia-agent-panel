import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { exigirMembro } from '@/lib/auth';
import { criarClienteServidor } from '@/lib/supabase/server';
import { desdeJanela } from '@/lib/retencao';

import { BuscaConversas } from './busca';
import { ListaConversas } from './lista';

/** Sem acento e sem caixa: ninguém digita "Débora" certo com o cliente esperando. */
function normalizar(t: string): string {
  return t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

export default async function PaginaConversas({
  searchParams,
}: {
  searchParams?: Promise<{ q?: string }>;
}) {
  const usuario = await exigirMembro('ver_conversas');
  const termo = String((await searchParams)?.q ?? '').trim();
  const supabase = await criarClienteServidor();

  /*
   * LE DA VIEW `conversas_painel`, nao da tabela (migracao 51). A tabela guarda
   * `status` CRU, que e lapide desde a 47: pausa vencida segue gravada como
   * 'pausado' ate a proxima escrita. Em 21/08 isso eram 9 conversas do emporio
   * mostradas como pausadas com o bot atendendo nelas.
   *
   * A view nao tem coluna `status` — chama-se `status_bruto` — entao pedir a
   * antiga aqui estoura em vez de voltar a mentir.
   *
   * A ESCRITA continua na tabela (ver `acoes.ts`): a view e so leitura.
   */
  const { data: conversas } = await supabase
    .from('conversas_painel')
    .select('conversation_id, contact_name, phone, status_efetivo, motivo_pausa, pausa_expira_em, atualizado_em')
    .eq('tenant_id', usuario.tenantId)
    // Janela da retenção (docs/POLITICA-RETENCAO.md): o que é mais velho já não tem texto.
    .gte('atualizado_em', desdeJanela())
    .order('atualizado_em', { ascending: false })
    .limit(200);

  // Filtro no servidor, sobre a janela já carregada: são 200 linhas no máximo
  // (a janela da retenção), e `ilike` no banco não acharia "debora" por
  // "Débora". A busca que a pessoa faz é a do balcão, com o cliente esperando.
  const filtradas = (conversas ?? []).filter((c) => {
    if (!termo) return true;
    const q = normalizar(termo);
    const digitos = q.replace(/\D/g, '');
    if (c.contact_name && normalizar(String(c.contact_name)).includes(q)) return true;
    if (digitos && String(c.phone ?? '').includes(digitos)) return true;
    if (digitos && String(c.conversation_id) === digitos) return true;
    return false;
  });

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
        <CardContent className="flex flex-col gap-4">
          <BuscaConversas valor={termo} />
          {filtradas.length > 0 ? (
            <ListaConversas conversas={filtradas} />
          ) : (
            <p className="text-sm text-muted-foreground">
              {termo
                ? 'Nenhuma conversa com esse nome, telefone ou número.'
                : 'Nenhuma conversa ainda.'}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
