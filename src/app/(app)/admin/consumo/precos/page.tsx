import Link from 'next/link';

import { FormularioPreco } from './formulario-preco';
import { Alert } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { exigirSuperAdmin } from '@/lib/auth';
import { criarClienteServidor } from '@/lib/supabase/server';
import { formatarDataUTC } from '@/lib/utils';

/**
 * Tabela de preços — configuração, não painel.
 *
 * Saiu de `/admin/consumo` porque disputava a tela com o dado que se olha toda
 * semana enquanto ela própria muda no máximo duas vezes por ano. Aqui ela tem a
 * página inteira e, principalmente, tem o texto que explica por que não há
 * botão de editar: o modelo é de VIGÊNCIA, não de valor corrente.
 */

/*
 * Formatador PRÓPRIO, e não o `formatarUsd` do consumo.
 *
 * Aqui a grandeza é preço por 1M de tokens (US$ 2,00; US$ 0,40; US$ 0,02), não
 * custo mensal em centavos. `formatarUsd` fixa quatro casas abaixo de um dólar
 * para alinhar a coluna de custo, e aplicado nesta tabela produziria "$0.4000" e
 * "$0.0200" — mais ruído, não menos. Escalas diferentes, formatadores diferentes.
 */
const usd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

export default async function PaginaPrecos() {
  await exigirSuperAdmin();
  const supabase = await criarClienteServidor();

  const { data: precos, error } = await supabase
    .from('precos_modelo')
    .select('modelo, vigente_desde, usd_entrada_por_1m, usd_saida_por_1m, usd_embedding_por_1m')
    .order('modelo')
    .order('vigente_desde', { ascending: false });

  const lista = precos ?? [];
  // A linha em vigor HOJE de cada modelo é a de maior `vigente_desde` que já
  // começou — a mesma regra que a RPC aplica por lateral join, só que na data
  // de agora em vez da data da mensagem. A query já vem ordenada por
  // `vigente_desde` decrescente dentro do modelo, então é a PRIMEIRA linha do
  // modelo cuja data não é futura.
  //
  // Map (modelo -> a data em vigor) e não Set de chave concatenada: a chave
  // composta exigiria montar a mesma string nos dois lugares, e basta o
  // separador divergir entre o `add` e o `has` para o selo "em vigor"
  // simplesmente nunca aparecer — sem erro, sem log, sem nada.
  const agora = Date.now();
  const emVigor = new Map<string, string>();
  for (const p of lista) {
    if (!emVigor.has(p.modelo) && new Date(p.vigente_desde).getTime() <= agora) {
      emVigor.set(p.modelo, p.vigente_desde);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <Link
          href="/admin/consumo"
          className="text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          ← Consumo do mês
        </Link>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Tabela de preços</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Preços da OpenAI por 1M de tokens, em USD. É a base de cálculo de todo custo mostrado
            no consumo.
          </p>
        </div>
      </header>

      {/*
        O TEXTO QUE FALTAVA. A tela antiga mostrava a tabela e um formulário de
        "nova vigência" sem dizer o que era vigência — e a pergunta que ela
        provoca ("por que não posso corrigir a linha errada?") tem uma resposta
        que muda o comportamento de quem mexe.
      */}
      <Card>
        <CardHeader>
          <CardTitle>Como esta tabela funciona</CardTitle>
          <CardDescription>Leia antes de mexer. São três regras.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm text-muted-foreground">
          <p>
            <strong className="text-foreground">O preço é versionado por data.</strong> Cada linha
            vale a partir do seu <em>vigente desde</em> e continua valendo até que exista uma linha
            mais nova do mesmo modelo. Não há data de fim: a próxima vigência é que encerra a
            anterior.
          </p>
          <p>
            <strong className="text-foreground">
              O custo histórico usa o preço da época, não o de hoje.
            </strong>{' '}
            O consumo de julho é calculado com a tabela que estava em vigor em julho. É por isso que
            o número de um mês fechado não muda quando a OpenAI reajusta.
          </p>
          <p>
            <strong className="text-foreground">
              Por isso não se edita uma linha antiga — acrescenta-se uma nova.
            </strong>{' '}
            Corrigir a linha de janeiro reescreveria o custo de todos os meses já fechados. Quando o
            preço mudar, registre a nova vigência abaixo com a data em que ela passou a valer. Na
            prática isso acontece no máximo duas vezes por ano.
          </p>
          <p className="text-xs">
            Consequência a saber: se o valor de uma linha estiver <em>errado</em> (e não apenas
            desatualizado), acrescentar vigência não conserta o passado. Nesse caso a correção é no
            banco, de propósito e com o impacto no histórico assumido.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Vigências registradas</CardTitle>
          <CardDescription>Mais recente primeiro, agrupado por modelo.</CardDescription>
        </CardHeader>
        <CardContent className="p-0 pb-6">
          {error ? (
            <div className="px-6">
              <Alert variant="destructive">
                Não foi possível carregar os preços: {error.message}
              </Alert>
            </div>
          ) : lista.length === 0 ? (
            <p className="px-6 text-sm text-muted-foreground">
              Nenhum preço cadastrado — todo custo sairia zero. Registre ao menos uma vigência por
              modelo em uso.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Modelo</TableHead>
                  <TableHead>Vigente desde</TableHead>
                  <TableHead className="text-right">Entrada / 1M</TableHead>
                  <TableHead className="text-right">Saída / 1M</TableHead>
                  <TableHead className="text-right">Embedding / 1M</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {lista.map((p) => {
                  const ehVigente = emVigor.get(p.modelo) === p.vigente_desde;
                  return (
                    <TableRow
                      key={`${p.modelo}-${p.vigente_desde}`}
                      className={ehVigente ? undefined : 'opacity-60'}
                    >
                      <TableCell className="font-medium">
                        {p.modelo}
                        {ehVigente ? (
                          <span className="ml-2 text-xs font-normal text-success">em vigor</span>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {formatarDataUTC(p.vigente_desde)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {p.usd_entrada_por_1m != null ? usd.format(Number(p.usd_entrada_por_1m)) : '—'}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {p.usd_saida_por_1m != null ? usd.format(Number(p.usd_saida_por_1m)) : '—'}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {p.usd_embedding_por_1m != null
                          ? usd.format(Number(p.usd_embedding_por_1m))
                          : '—'}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Nova vigência</CardTitle>
          <CardDescription>
            Use quando a OpenAI reajustar. A data é o dia em que o preço novo passou a valer — o
            consumo anterior a ela continua calculado pela vigência antiga.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FormularioPreco />
        </CardContent>
      </Card>
    </div>
  );
}
