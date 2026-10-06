import { formatarBRL } from '@/lib/vendas/dinheiro';

/**
 * Uma fala da conversa, com QUEM falou.
 *
 * 06/10/2026: a tela mostrava toda saída como "Agente". Nos últimos 30 dias há
 * 20 falas de ATENDENTE (`fonte_tokens = 'humano'`) e 14 do SISTEMA (o aviso de
 * mídia não suportada, o endereço de retirada que a tool manda). Quem abre a
 * conversa para conferir se a IA falou certo precisa distinguir: corrigir o
 * prompt por causa de uma frase que um colega escreveu é trabalho jogado fora,
 * e mexer no prompt por causa de um texto fixo do sistema é pior — o prompt não
 * controla aquilo.
 *
 * A classificação vem do banco (`painel_conversa_mensagens`, migração 84), não
 * daqui: os nomes internos de `fonte_tokens` já mudaram uma vez (na 76) e a
 * tela não deve conhecê-los.
 */
export type Fonte = 'cliente' | 'agente' | 'atendente' | 'sistema';

const ESTILO: Record<Fonte, { rotulo: string; bolha: string; lado: string }> = {
  cliente: {
    rotulo: 'Cliente',
    bolha: 'border-border bg-muted text-foreground',
    lado: 'items-start',
  },
  agente: {
    rotulo: 'Agente',
    bolha: 'border-primary/20 bg-primary/15 text-foreground',
    lado: 'items-end',
  },
  // Cor própria, e não a do agente: é a diferença que a tela existe para
  // mostrar. Verde porque é gente — a mesma leitura do badge "ativo".
  atendente: {
    rotulo: 'Atendente (pessoa da sua equipe)',
    bolha: 'border-success/30 bg-success/10 text-foreground',
    lado: 'items-end',
  },
  // Nem bolha: é texto fixo que o sistema manda, não conversa. Tratá-lo como
  // fala do agente é o que fazia alguém procurar no prompt uma frase que não
  // está lá.
  sistema: {
    rotulo: 'Mensagem automática do sistema',
    bolha: 'border-dashed border-border bg-transparent text-muted-foreground',
    lado: 'items-center',
  },
};

function dataHora(iso: string): string {
  try {
    return new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

export function Mensagem({
  fonte,
  conteudo,
  criadoEm,
}: {
  fonte: string;
  conteudo: string | null;
  criadoEm: string;
}) {
  const e = ESTILO[(fonte as Fonte)] ?? ESTILO.agente;
  return (
    <div className={`flex flex-col gap-1 ${e.lado}`}>
      <div className={`max-w-[75%] whitespace-pre-wrap rounded-lg border px-3 py-2 text-sm ${e.bolha}`}>
        {conteudo ?? <span className="italic text-muted-foreground">(sem conteúdo)</span>}
      </div>
      <span className="text-xs text-muted-foreground">
        {e.rotulo} · {dataHora(criadoEm)}
      </span>
    </div>
  );
}

/** O pedido que saiu desta conversa, para ir e voltar sem procurar. */
export function PedidoDaConversa({
  pedidos,
}: {
  pedidos: { id: string; numero: number | null; status: string; total_centavos: number }[];
}) {
  if (pedidos.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="text-muted-foreground">
        {pedidos.length === 1 ? 'Pedido desta conversa:' : 'Pedidos desta conversa:'}
      </span>
      {pedidos.map((p) => (
        <a
          key={p.id}
          href={`/painel/pedidos/${p.id}`}
          className="rounded-md border border-border px-2 py-1 underline-offset-4 hover:underline"
        >
          {p.numero ? `nº ${p.numero}` : 'em aberto'} · {formatarBRL(p.total_centavos)}
        </a>
      ))}
    </div>
  );
}
