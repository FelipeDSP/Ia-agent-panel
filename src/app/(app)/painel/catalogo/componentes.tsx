'use client';

import { Package, Pencil, Plus, Trash2, X } from 'lucide-react';
import { useActionState, useRef, useState, useTransition } from 'react';

import { excluirProduto, salvarProduto, type EstadoProduto } from './acoes';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { SubmitButton } from '@/components/ui/submit-button';
import { Textarea } from '@/components/ui/textarea';
import { centavosParaReais, formatarBRL } from '@/lib/vendas/dinheiro';

import { FotoProduto } from './componentes-foto';
import { UNIDADES } from '@/lib/vendas/schema';

export type Produto = {
  id: string;
  nome: string;
  descricao: string | null;
  precoCentavos: number;
  unidade: string;
  sku: string | null;
  estoque: number | null;
  disponivel: boolean;
  /** URL assinada de vida curta, ou null se o produto não tem foto. */
  fotoUrl: string | null;
};

function ErroCampo({ msg }: { msg?: string }) {
  if (!msg) return null;
  return <p className="text-xs text-destructive">{msg}</p>;
}

function rotuloUnidade(valor: string): string {
  return UNIDADES.find((u) => u.valor === valor)?.rotulo ?? valor;
}

/**
 * Excluir com confirmação inline em dois passos — mesmo padrão do
 * BotaoExcluirDocumento. Um clique só era fácil demais de errar numa lista.
 */
function BotaoExcluir({
  nome,
  excluindo,
  onConfirmar,
}: {
  nome: string;
  excluindo: boolean;
  onConfirmar: () => void;
}) {
  const [confirmando, setConfirmando] = useState(false);

  if (!confirmando) {
    return (
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setConfirmando(true)}
        disabled={excluindo}
        aria-label={`Remover ${nome}`}
      >
        <Trash2 className="h-4 w-4" />
      </Button>
    );
  }

  return (
    <div className="flex items-center gap-1">
      <Button variant="destructive" size="sm" onClick={onConfirmar} disabled={excluindo}>
        {excluindo ? 'Removendo…' : 'Confirmar'}
      </Button>
      <Button variant="ghost" size="sm" onClick={() => setConfirmando(false)} aria-label="Cancelar">
        <X className="h-4 w-4" />
      </Button>
    </div>
  );
}

function FormularioProduto({
  editando,
  onCancelar,
  unidadePadrao,
  onUnidadeMudou,
}: {
  editando: Produto | null;
  onCancelar: () => void;
  unidadePadrao: string;
  onUnidadeMudou: (u: string) => void;
}) {
  const [estado, acao] = useActionState<EstadoProduto, FormData>(salvarProduto, {});

  /**
   * O formulário REMONTA a cada retorno da action, via `key` — e é a remontagem
   * que reaplica os `defaultValue`. Duas coisas dependem disso:
   *
   *  - no ERRO, os campos voltam com o que o cliente digitou (`enviado`). O
   *    React 19 reseta formulário não-controlado depois de uma action, mesmo
   *    quando ela falha; sem isto, errar o preço apagava nome, descrição e tudo.
   *  - no SUCESSO, o form volta vazio para o próximo cadastro, já com a última
   *    unidade escolhida. `form.reset()` não serviria: ele devolve o valor de
   *    quando o form montou, não o `unidadePadrao` atual.
   */
  const v = (campo: string, queda: string) => estado.enviado?.[campo] ?? queda;

  return (
    <form
      action={acao}
      className="flex flex-col gap-4"
      key={`${editando?.id ?? 'novo'}-${estado.tentativa ?? 0}`}
    >
      {estado.erro ? <Alert variant="destructive">{estado.erro}</Alert> : null}
      {estado.sucesso ? <Alert variant="success">{estado.sucesso}</Alert> : null}

      {editando ? <input type="hidden" name="id" value={editando.id} /> : null}

      <div className="flex flex-col gap-2">
        <Label htmlFor="nome">Nome</Label>
        <Input
          id="nome"
          name="nome"
          defaultValue={v('nome', editando?.nome ?? '')}
          placeholder="Ex.: Camisa polo masculina"
          maxLength={120}
          required
        />
        <ErroCampo msg={estado.errosCampo?.['nome']} />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="descricao">Descrição</Label>
        <Textarea
          id="descricao"
          name="descricao"
          defaultValue={v('descricao', editando?.descricao ?? '')}
          placeholder="O que o agente precisa saber para explicar este item ao cliente."
          rows={3}
          maxLength={2000}
        />
        <ErroCampo msg={estado.errosCampo?.['descricao']} />
      </div>

      <div className="flex flex-wrap gap-4">
        <div className="flex w-40 flex-col gap-2">
          <Label htmlFor="preco">Preço (R$)</Label>
          <Input
            id="preco"
            name="preco"
            inputMode="decimal"
            defaultValue={v('preco', editando ? centavosParaReais(editando.precoCentavos) : '')}
            placeholder="24,90"
            required
          />
          <ErroCampo msg={estado.errosCampo?.['preco']} />
        </div>

        <div className="flex w-52 flex-col gap-2">
          <Label htmlFor="unidade">Unidade</Label>
          {/* Sem `editando`, o padrão é a última unidade escolhida nesta sessão:
              quem cadastra 8 pratos seguidos escolhia "Porção" 8 vezes, porque o
              form reseta a cada item salvo. É a coisa que menos varia dentro de
              um catálogo. Mora em estado de tela, não no banco — voltar amanhã
              volta ao padrão. */}
          <Select
            id="unidade"
            name="unidade"
            defaultValue={v('unidade', editando?.unidade ?? unidadePadrao)}
            onChange={(e) => onUnidadeMudou(e.target.value)}
          >
            {UNIDADES.map((u) => (
              <option key={u.valor} value={u.valor}>
                {u.rotulo}
              </option>
            ))}
          </Select>
          <ErroCampo msg={estado.errosCampo?.['unidade']} />
        </div>

        <div className="flex w-40 flex-col gap-2">
          <Label htmlFor="sku">Código / SKU</Label>
          <Input
            id="sku"
            name="sku"
            defaultValue={v('sku', editando?.sku ?? '')}
            placeholder="Opcional"
            maxLength={60}
          />
          <ErroCampo msg={estado.errosCampo?.['sku']} />
        </div>

        <div className="flex w-40 flex-col gap-2">
          <Label htmlFor="estoque">Estoque</Label>
          <Input
            id="estoque"
            name="estoque"
            type="number"
            min="0"
            step="1"
            defaultValue={v('estoque', editando?.estoque?.toString() ?? '')}
            placeholder="Deixe vazio"
          />
          <ErroCampo msg={estado.errosCampo?.['estoque']} />
        </div>
      </div>

      <p className="-mt-1 text-xs text-muted-foreground">
        Preço em reais, com vírgula ou ponto — <strong>24,90</strong> ou <strong>24.90</strong>.
        Estoque vazio significa <strong>não controla estoque</strong>; zero significa esgotado.
      </p>

      {/* Campo espelho: checkbox desmarcado não vai no POST, então sem ele o
          servidor não distinguiria "desmarcou" de "formulário sem o campo". */}
      <input type="hidden" name="disponivel_presente" value="1" />
      <label className="flex items-center gap-3">
        <input
          type="checkbox"
          name="disponivel"
          defaultChecked={estado.enviado ? estado.enviado['disponivel'] === 'on' : editando ? editando.disponivel : true}
          className="h-4 w-4 accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        />
        <span className="text-sm">Disponível para venda</span>
      </label>
      <p className="-mt-3 text-xs text-muted-foreground">
        Desmarque para pausar o item — “hoje não tem” — sem apagar o cadastro nem mexer no
        estoque. Ele continua aqui para você reativar depois.
      </p>

      <div className="flex items-center gap-2">
        <SubmitButton>{editando ? 'Salvar alterações' : 'Adicionar ao catálogo'}</SubmitButton>
        {editando ? (
          <Button type="button" variant="ghost" onClick={onCancelar}>
            Cancelar
          </Button>
        ) : null}
      </div>
    </form>
  );
}

export function GestaoCatalogo({
  produtosIniciais,
  podeFoto,
}: {
  produtosIniciais: Produto[];
  /**
   * Se o tenant contratou `foto_produto`. Resolvido no servidor (a página).
   *
   * A miniatura e o controle de upload são superfície daquela tool, e a regra é
   * a mesma das rotas: só existe para quem contratou. Sem isto, um cliente com
   * Vendas e sem Foto via o controle e conseguia subir imagem — a Server Action
   * agora também recusa, mas mostrar um botão que o servidor nega é pior que
   * não mostrar.
   */
  podeFoto: boolean;
}) {
  const [editando, setEditando] = useState<Produto | null>(null);
  // Última unidade escolhida NESTA sessão de tela. Não vai ao banco de
  // propósito: é conveniência de digitação, não preferência do cliente —
  // recarregar a página volta para "un".
  const [unidadePadrao, setUnidadePadrao] = useState('un');
  const [erroExclusao, setErroExclusao] = useState<string | null>(null);
  const [excluindoId, setExcluindoId] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const topo = useRef<HTMLDivElement>(null);

  function editar(p: Produto) {
    setEditando(p);
    topo.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function remover(p: Produto) {
    setErroExclusao(null);
    setExcluindoId(p.id);
    startTransition(async () => {
      const r = await excluirProduto(p.id);
      if (r.erro) setErroExclusao(r.erro);
      // Sai do modo de edição se o produto editado foi o removido.
      if (!r.erro && editando?.id === p.id) setEditando(null);
      setExcluindoId(null);
    });
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Âncora à parte: Card não encaminha ref. */}
      <div ref={topo} className="scroll-mt-4" />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {editando ? (
              <>
                <Pencil className="h-4 w-4" /> Editando “{editando.nome}”
              </>
            ) : (
              <>
                <Plus className="h-4 w-4" /> Novo produto
              </>
            )}
          </CardTitle>
          <CardDescription>
            {editando
              ? 'Altere o que precisar e salve. O preço é o que o agente vai informar ao cliente.'
              : 'Cadastre o que você vende. Nome e preço bastam para começar.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FormularioProduto
            key={editando?.id ?? 'novo'}
            editando={editando}
            onCancelar={() => setEditando(null)}
            unidadePadrao={unidadePadrao}
            onUnidadeMudou={setUnidadePadrao}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Meu catálogo</CardTitle>
          <CardDescription>
            {produtosIniciais.length === 0
              ? 'Nenhum produto cadastrado.'
              : `${produtosIniciais.length} produto${produtosIniciais.length > 1 ? 's' : ''} no catálogo.`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {erroExclusao ? (
            <Alert variant="destructive" className="mb-4">
              {erroExclusao}
            </Alert>
          ) : null}

          {produtosIniciais.length === 0 ? (
            <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border px-6 py-10 text-center">
              <Package className="h-8 w-8 text-muted-foreground" />
              <div>
                <p className="font-medium">Seu catálogo está vazio</p>
                <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
                  Cadastre acima o primeiro item que você vende — um prato, uma peça, um serviço.
                  Comece pelos mais pedidos: são os que mais aparecem nas conversas.
                </p>
              </div>
            </div>
          ) : (
            <div className="flex flex-col divide-y divide-border">
              {produtosIniciais.map((p) => (
                <div
                  key={p.id}
                  className="flex flex-wrap items-start justify-between gap-3 py-3 first:pt-0 last:pb-0"
                >
                  {podeFoto ? (
                    <FotoProduto produtoId={p.id} nome={p.nome} fotoUrl={p.fotoUrl} />
                  ) : null}

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{p.nome}</span>
                      {p.sku ? <Badge variant="secondary">{p.sku}</Badge> : null}
                      {!p.disponivel ? <Badge variant="warning">pausado</Badge> : null}
                      {p.estoque === 0 ? (
                        <Badge variant="warning">esgotado</Badge>
                      ) : p.estoque !== null ? (
                        <Badge variant="secondary">{p.estoque} em estoque</Badge>
                      ) : null}
                    </div>
                    {p.descricao ? (
                      <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                        {p.descricao}
                      </p>
                    ) : null}
                  </div>

                  <div className="flex items-center gap-3">
                    <div className="text-right">
                      <div className="font-medium tabular-nums">{formatarBRL(p.precoCentavos)}</div>
                      <div className="text-xs text-muted-foreground">
                        por {rotuloUnidade(p.unidade).toLowerCase().replace(/\s*\(.*\)$/, '')}
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => editar(p)}
                      aria-label={`Editar ${p.nome}`}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <BotaoExcluir
                      nome={p.nome}
                      excluindo={excluindoId === p.id}
                      onConfirmar={() => remover(p)}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
