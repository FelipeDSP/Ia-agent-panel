import { Alert } from '@/components/ui/alert';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { exigirTenantAdmin } from '@/lib/auth';
import {
  atendimento,
  clientesQueVoltaram,
  conversasPorDia,
  pedidos as agregarPedidos,
  picos,
  porHora,
  rotuloHora,
  tempoDeResposta,
  type LinhaConversa,
  type LinhaMensagem,
  type LinhaPedido,
} from '@/lib/relatorios/agregar';
import { criarClienteServidor } from '@/lib/supabase/server';
import { temToolContratada } from '@/lib/tools/contratacao';
import { formatarBRL } from '@/lib/vendas/dinheiro';

/**
 * Relatórios do cliente.
 *
 * ERA "Uso", e contava mensagens. Número de mensagens é o dado que a agência
 * usa para ratear custo — não é pergunta de dono de loja. As três que ele faz e
 * não consegue responder em lugar nenhum estão aqui: a que HORAS o procuram,
 * quantas conversas o agente levou sozinho, e quanto virou pedido.
 *
 * JANELA DE 30 DIAS em tudo. Sem recorte, "das 14h às 16h" misturaria a semana
 * passada com o Natal do ano retrasado e pararia de reagir ao que mudou.
 */
const DIAS = 30;

/** Barra do histograma. Sem biblioteca: são 24 divs. */
function Barra({ n, max }: { n: number; max: number }) {
  const pct = max > 0 ? Math.round((n / max) * 100) : 0;
  return (
    <div className="h-24 w-full rounded-sm bg-muted" title={`${n} mensagem(ns)`}>
      <div
        className="mt-auto w-full rounded-sm bg-primary transition-all"
        style={{ height: `${pct}%`, marginTop: `${100 - pct}%` }}
      />
    </div>
  );
}

function Metrica({
  rotulo,
  valor,
  nota,
}: {
  rotulo: string;
  valor: string;
  nota?: string;
}) {
  return (
    <div>
      <p className="text-sm text-muted-foreground">{rotulo}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{valor}</p>
      {nota ? <p className="mt-0.5 text-xs text-muted-foreground">{nota}</p> : null}
    </div>
  );
}

export default async function PaginaRelatorios() {
  const usuario = await exigirTenantAdmin();
  const supabase = await criarClienteServidor();

  const desde = new Date(Date.now() - DIAS * 24 * 60 * 60 * 1000).toISOString();

  /*
   * O FUSO É O DA LOJA, não o do servidor. `criado_em` é TIMESTAMPTZ e chega em
   * UTC; dizer "seu pico é às 22h" para quem fecha às 18h não é imprecisão, é
   * erro visível na primeira olhada. O fuso já está configurado no módulo de
   * transferência; sem ele, o de Rondônia é o palpite menos errado para a base
   * de clientes de hoje.
   */
  const { data: cfg } = await supabase
    .from('tenant_tools')
    .select('config')
    .eq('tenant_id', usuario.tenantId)
    .eq('tool_nome', 'transferir_humano')
    .maybeSingle();
  const timezone =
    (cfg?.config as { horario?: { timezone?: string } } | null)?.horario?.timezone ??
    'America/Porto_Velho';

  // `eq('tenant_id')` é redundante com a RLS de propósito (regra 6 do CLAUDE.md).
  const [msgs, convs] = await Promise.all([
    supabase
      .from('mensagens_log')
      .select('criado_em, direcao, execucao_id')
      .eq('tenant_id', usuario.tenantId)
      .gte('criado_em', desde),
    supabase
      .from('conversas')
      .select('status, phone, criado_em, pausado_em')
      .eq('tenant_id', usuario.tenantId)
      .gte('criado_em', desde),
  ]);

  const mensagens = (msgs.data ?? []) as LinhaMensagem[];
  const conversas = (convs.data ?? []) as LinhaConversa[];

  /*
   * A seção de pedidos é SUPERFÍCIE DA TOOL `vendas` — mesma regra do menu e da
   * rota: só existe para quem contratou. Seção de tela conta como superfície,
   * ainda que não tenha rota própria.
   */
  const temVendas = await temToolContratada(usuario.tenantId, 'vendas');
  const { data: pedidosRaw } = temVendas
    ? await supabase
        .from('pedidos')
        .select('status, total_centavos, criado_em')
        .eq('tenant_id', usuario.tenantId)
        .gte('criado_em', desde)
    : { data: [] };

  const horas = porHora(mensagens, timezone);
  const maxHora = Math.max(...horas, 0);
  const topo = picos(horas);
  const at = atendimento(conversas);
  const volta = clientesQueVoltaram(conversas);
  const porDia = conversasPorDia(conversas, timezone);
  const resposta = tempoDeResposta(mensagens);
  const ped = agregarPedidos((pedidosRaw ?? []) as LinhaPedido[]);

  const erro = msgs.error ?? convs.error;
  const semNada = mensagens.length === 0 && conversas.length === 0;

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Relatórios</h1>
        <p className="mt-1 text-sm text-muted-foreground">Últimos {DIAS} dias.</p>
      </header>

      {erro ? <Alert variant="destructive">Não foi possível carregar: {erro.message}</Alert> : null}

      {semNada ? (
        <Card>
          <CardContent className="p-10 text-center">
            <p className="font-medium">Ainda não há movimento para relatar</p>
            <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
              Assim que seus clientes começarem a conversar, esta tela mostra em que horários eles
              procuram, quantas conversas o agente resolveu sozinho e quanto virou pedido.
            </p>
          </CardContent>
        </Card>
      ) : null}

      {/* ---------------- Pergunta 2: a que horas procuram ---------------- */}
      {mensagens.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>A que horas procuram você</CardTitle>
            <CardDescription>
              {topo.length > 0 ? (
                <>
                  Mais movimento às{' '}
                  <strong>{topo.map((p) => rotuloHora(p.hora)).join(', ')}</strong>. Horário de{' '}
                  {timezone.split('/')[1]?.replace('_', ' ')}.
                </>
              ) : (
                'Sem mensagens recebidas na janela.'
              )}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-end gap-1">
              {horas.map((n, h) => (
                <div key={h} className="flex flex-1 flex-col items-center gap-1">
                  <Barra n={n} max={maxHora} />
                  {h % 3 === 0 ? (
                    <span className="text-[10px] tabular-nums text-muted-foreground">{h}</span>
                  ) : (
                    <span className="text-[10px]">&nbsp;</span>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* --------- Pergunta 3: quantas o agente levou sozinho --------- */}
      {conversas.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Atendimento</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-6 sm:grid-cols-3">
            <Metrica
              rotulo="Conversas"
              valor={String(at.total)}
              nota={porDia.length > 1 ? `em ${porDia.length} dias com movimento` : undefined}
            />
            <Metrica
              rotulo="O agente resolveu sozinho"
              valor={at.pctSoAgente === null ? '—' : `${at.pctSoAgente}%`}
              nota={`${at.soAgente} de ${at.total}`}
            />
            <Metrica
              rotulo="Precisaram de uma pessoa"
              valor={String(at.comHumano)}
              nota={at.pausadasAgora > 0 ? `${at.pausadasAgora} ainda pausada(s)` : undefined}
            />
            {resposta ? (
              <Metrica
                rotulo="Tempo de resposta"
                valor={`${resposta.medianaSegundos}s`}
                nota={`mediana de ${resposta.turnos} respostas`}
              />
            ) : null}
            {volta.pessoas > 0 ? (
              <Metrica
                rotulo="Pessoas atendidas"
                valor={String(volta.pessoas)}
                nota={volta.voltaram > 0 ? `${volta.voltaram} voltaram mais de uma vez` : undefined}
              />
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {/* ------------- Pergunta 4: quanto virou pedido ------------- */}
      {temVendas && ped.total > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Pedidos</CardTitle>
            <CardDescription>
              {conversas.length > 0
                ? `${ped.total} pedido(s) em ${conversas.length} conversa(s).`
                : null}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-6 sm:grid-cols-3">
            <Metrica rotulo="Pagos" valor={String(ped.pago)} />
            <Metrica rotulo="Receita" valor={formatarBRL(ped.receitaCentavos)} nota="dos pagos" />
            <Metrica
              rotulo="Aguardando pagamento"
              valor={String(ped.aguardando)}
              nota={ped.expirado > 0 ? `${ped.expirado} expirou por falta de pagamento` : undefined}
            />
            {/*
              Carrinho abandonado é o número que ninguém pede e mais ensina: foi
              intenção que existiu e não fechou. Só aparece quando existe — zero
              rascunhos não é informação.
            */}
            {ped.rascunho > 0 ? (
              <Metrica
                rotulo="Carrinhos abandonados"
                valor={String(ped.rascunho)}
                nota="montaram e não fecharam"
              />
            ) : null}
            {ped.cancelado > 0 ? (
              <Metrica rotulo="Cancelados" valor={String(ped.cancelado)} />
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
