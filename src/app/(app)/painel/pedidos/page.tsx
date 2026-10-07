import { ShoppingCart } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { Ajuda } from '@/components/ui/ajuda';
import { Alert } from '@/components/ui/alert';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { exigirMembro } from '@/lib/auth';
import { criarClienteServidor } from '@/lib/supabase/server';
import { lerHorarioAgente } from '@/lib/tenants/horario-agente';

import { Atualiza } from './atualiza';
import { Busca } from './busca';
import { casaBusca, montarFila, naFila, type PedidoDaFila } from './fila';
import { LinhaPedido } from './linha';
import { lerEMarcarVistos } from './vistos';

const ABAS = [
  ['fila', 'A fazer'],
  ['historico', 'Já saíram'],
  ['rascunhos', 'Em aberto'],
] as const;
type Aba = (typeof ABAS)[number][0];

export default async function PaginaPedidos({
  searchParams,
}: {
  searchParams?: Promise<{ ver?: string; q?: string }>;
}) {
  const usuario = await exigirMembro();
  const sp = (await searchParams) ?? {};
  const aba: Aba = ABAS.some(([c]) => c === sp.ver) ? (sp.ver as Aba) : 'fila';
  const termo = String(sp.q ?? '').trim();

  // O marcador de "até onde esta pessoa viu" — LIDO antes de ser carimbado,
  // senão a própria visita apagaria o que ela veio ver.
  const vistosAte = await lerEMarcarVistos(usuario.id, usuario.tenantId);

  const supabase = await criarClienteServidor();

  // O fuso da loja: a fila agrupa por DIA, e "hoje" em Ariquemes não é "hoje"
  // em São Paulo. Sem horário configurado, o padrão é o mesmo do agente.
  const { data: tenant } = await supabase
    .from('tenants')
    .select('horario_agente')
    .eq('id', usuario.tenantId)
    .maybeSingle();
  const tz = lerHorarioAgente(tenant?.horario_agente ?? null)?.timezone ?? 'America/Sao_Paulo';

  // RLS já escopa por tenant; filtro explícito como segunda camada (regra 6).
  const { data, error } = await supabase
    .from('pedidos')
    .select(
      'id, numero, conversation_id, status, total_centavos, criado_em, pagamento_modo, pago_em, retirado_em, retirada_nome, quando_em, separado_em, pedido_itens(id)',
    )
    .eq('tenant_id', usuario.tenantId)
    .is('deletado_em', null)
    .order('criado_em', { ascending: false })
    .limit(300);

  if (error) {
    return (
      <Alert variant="destructive">
        Não foi possível carregar os pedidos.
        {/quando_em|separado_em/.test(error.message)
          ? ' A migração 83 ainda não foi aplicada neste banco.'
          : ''}
      </Alert>
    );
  }

  const todos: PedidoDaFila[] = (data ?? []).map((p) => ({
    id: String(p.id),
    numero: (p.numero as number | null) ?? null,
    status: String(p.status),
    total_centavos: Number(p.total_centavos ?? 0),
    quando_em: (p.quando_em as string | null) ?? null,
    separado_em: (p.separado_em as string | null) ?? null,
    retirado_em: (p.retirado_em as string | null) ?? null,
    pago_em: (p.pago_em as string | null) ?? null,
    pagamento_modo: (p.pagamento_modo as string | null) ?? null,
    retirada_nome: (p.retirada_nome as string | null) ?? null,
    conversation_id: Number(p.conversation_id ?? 0),
    criado_em: String(p.criado_em),
    itens: Array.isArray(p.pedido_itens) ? p.pedido_itens.length : 0,
  }));

  const filtrados = todos.filter((p) => casaBusca(p, termo));
  const fila = montarFila(filtrados, new Date(), tz);
  const historico = filtrados
    .filter((p) => p.retirado_em || p.status === 'cancelado' || p.status === 'expirado')
    .slice(0, 100);
  const rascunhos = filtrados.filter((p) => p.status === 'rascunho');
  const naFilaN = todos.filter(naFila).length;

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Pedidos</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {naFilaN === 0 ? 'Nada para preparar agora.' : `${naFilaN} pedido(s) para preparar.`}
        </p>
      </header>

      <nav className="flex flex-wrap gap-1 border-b border-border" aria-label="Pedidos">
        {ABAS.map(([chave, rotulo]) => (
          <Link
            key={chave}
            href={`/painel/pedidos${chave === 'fila' ? '' : `?ver=${chave}`}`}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${aba === chave ? 'border-primary font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
            aria-current={aba === chave ? 'page' : undefined}
          >
            {rotulo}
          </Link>
        ))}
      </nav>

      <Busca valor={termo} aba={aba} />
      {/* A fila é tela de plantão: fica aberta enquanto se trabalha. Sem isto,
          um pedido que fechou às 10h03 só apareceria quando alguém lembrasse
          de apertar F5. */}
      <Atualiza segundos={45} />

      {/* AS TRÊS ABAS SÃO O MESMO BLOCO: título, contagem, ajuda, e linhas com
          o mesmo esqueleto. Só muda o conteúdo. Antes a fila tinha uma forma e
          as outras duas tinham outra — e quem trabalha nas três o dia inteiro
          tinha de reaprender a ler a cada clique (observação do Felipe, 06/10). */}
      {aba === 'fila' ? (
        fila.length === 0 ? (
          <Vazio
            titulo={termo ? 'Nada encontrado' : 'Nenhum pedido para preparar'}
            texto={
              termo
                ? 'Procure pelo número do pedido ou pelo nome de quem vem buscar.'
                : 'Quando o agente fechar um pedido numa conversa, ele aparece aqui na hora combinada.'
            }
          />
        ) : (
          fila.map((g) => (
            <Bloco
              key={g.chave}
              titulo={g.rotulo}
              n={g.pedidos.length}
              alerta={g.chave === 'atrasado'}
              ajuda={
                g.chave === 'sem_horario' ? (
                  <>
                    O agente pergunta quando o cliente vem buscar e grava a hora. Estes fecharam sem
                    ninguém combinar — ou são de antes de o agente passar a perguntar.
                    <br />
                    <br />
                    Abra o pedido para ver a conversa e combinar.
                  </>
                ) : null
              }
            >
              {g.pedidos.map((p) => (
                <LinhaPedido
                  key={p.id}
                  p={p}
                  tz={tz}
                  mostrarHora
                  acao="passo"
                  novo={Boolean(vistosAte && p.criado_em > vistosAte)}
                />
              ))}
            </Bloco>
          ))
        )
      ) : null}

      {aba === 'historico' ? (
        <Bloco
          titulo="Já saíram"
          n={historico.length}
          ajuda={
            <>
              Pedidos que terminaram: entregues ao cliente, cancelados, ou que expiraram sem
              pagamento.
              <br />
              <br />
              Os 100 mais recentes.
            </>
          }
        >
          {historico.length === 0 ? (
            <p className="py-3 text-sm text-muted-foreground">Nenhum pedido encerrado ainda.</p>
          ) : (
            historico.map((p) => (
              <LinhaPedido key={p.id} p={p} tz={tz} mostrarHora={false} acao="nenhuma" />
            ))
          )}
        </Bloco>
      ) : null}

      {aba === 'rascunhos' ? (
        <Bloco
          titulo="Em aberto"
          n={rascunhos.length}
          ajuda={
            <>
              Carrinho que o agente ainda está montando numa conversa. Os itens podem mudar, e por
              isso ele <strong>não</strong> entra na fila de preparo — o cliente ainda não fechou.
              <br />
              <br />
              Se um ficou parado há dias, a conversa provavelmente morreu.
            </>
          }
        >
          {rascunhos.length === 0 ? (
            <p className="py-3 text-sm text-muted-foreground">Nenhum carrinho em aberto.</p>
          ) : (
            rascunhos.map((p) => (
              <LinhaPedido key={p.id} p={p} tz={tz} mostrarHora={false} acao="nenhuma" />
            ))
          )}
        </Bloco>
      ) : null}
    </div>
  );
}

/** O mesmo invólucro para toda aba e todo grupo da fila. */
function Bloco({
  titulo,
  n,
  ajuda,
  alerta,
  children,
}: {
  titulo: string;
  n: number;
  ajuda?: ReactNode;
  alerta?: boolean;
  children: ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-1.5 text-base">
          <span className={alerta ? 'text-destructive' : undefined}>{titulo}</span>
          <span className="text-sm font-normal text-muted-foreground">({n})</span>
          {ajuda ? <Ajuda titulo={titulo}>{ajuda}</Ajuda> : null}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col divide-y divide-border">{children}</CardContent>
    </Card>
  );
}

function Vazio({ titulo, texto }: { titulo: string; texto: string }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border px-6 py-10 text-center">
      <ShoppingCart className="h-8 w-8 text-muted-foreground" />
      <div>
        <p className="font-medium">{titulo}</p>
        <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">{texto}</p>
      </div>
    </div>
  );
}
