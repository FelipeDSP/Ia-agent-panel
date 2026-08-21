'use client';

import { Eraser } from 'lucide-react';
import Link from 'next/link';
import { useState, useTransition } from 'react';

import { limparMemoriaConversas, type EstadoConversa } from './acoes';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

export type ConversaResumo = {
  conversation_id: number;
  contact_name: string | null;
  phone: string | null;
  /** Vem da view `conversas_painel`: a pausa JA resolvida. Nunca o `status` cru. */
  status_efetivo: string;
  motivo_pausa: string | null;
  pausa_expira_em: string | null;
  atualizado_em: string | null;
};

/** HH:MM local, para "o agente volta às". */
function hora(iso: string | null): string | null {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return null;
  }
}

/*
 * TRES estados, nao dois — e o terceiro e o que a migracao 51 tornou possivel
 * dizer.
 *
 * Pausa MANUAL e pausa por MENSAGEM HUMANA sao fatos diferentes e o rotulo
 * acompanha: no primeiro alguem clicou e so sai clicando; no segundo NINGUEM
 * pausou, alguem respondeu — e o agente volta sozinho na hora mostrada.
 * Chamar os dois de "pausado" faria o dono procurar um botao que nao existe.
 */
export function StatusBadge({
  status_efetivo,
  motivo_pausa,
  pausa_expira_em,
}: Pick<ConversaResumo, 'status_efetivo' | 'motivo_pausa' | 'pausa_expira_em'>) {
  if (status_efetivo === 'resolvido') return <Badge variant="secondary">resolvido</Badge>;
  if (status_efetivo !== 'pausado') return <Badge variant="success">ativo</Badge>;

  if (motivo_pausa === 'manual') {
    return <Badge variant="warning" title="Alguém pausou pelo painel. Só sai clicando em Retomar.">pausado</Badge>;
  }
  const volta = hora(pausa_expira_em);
  return (
    <Badge variant="warning" title="Alguém respondeu esta conversa. O agente volta sozinho.">
      em atendimento humano{volta ? ` · volta às ${volta}` : ''}
    </Badge>
  );
}

function dataCurta(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

/**
 * Lista de conversas com seleção para limpar memória (Redis, via n8n) de uma,
 * várias ou todas. O checkbox não navega — só o resto da linha é link. "Limpar
 * todas" e a limpeza em massa confirmam em dois passos inline (sem window.confirm,
 * que trava a aba). Limpar memória não apaga o histórico exibido.
 */
export function ListaConversas({ conversas }: { conversas: ConversaResumo[] }) {
  const [selecao, setSelecao] = useState<Set<number>>(new Set());
  const [confirmando, setConfirmando] = useState<null | 'selecao' | 'todas'>(null);
  const [feedback, setFeedback] = useState<EstadoConversa>({});
  const [pendente, iniciar] = useTransition();

  const alternar = (id: number) =>
    setSelecao((atual) => {
      const proximo = new Set(atual);
      if (proximo.has(id)) proximo.delete(id);
      else proximo.add(id);
      return proximo;
    });

  const executar = (alvo: number[] | 'todas') =>
    iniciar(async () => {
      const r = await limparMemoriaConversas(alvo);
      setFeedback(r);
      setConfirmando(null);
      if (!r.erro) setSelecao(new Set());
    });

  const nSel = selecao.size;

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-3">
        <p className="text-xs text-muted-foreground">
          {nSel > 0 ? `${nSel} selecionada(s)` : `${conversas.length} conversa(s)`}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {confirmando === 'selecao' ? (
            <>
              <span className="text-xs text-muted-foreground">
                Limpar memória de {nSel} conversa(s)?
              </span>
              <Button
                variant="destructive"
                size="sm"
                disabled={pendente}
                onClick={() => executar([...selecao])}
              >
                {pendente ? 'Limpando…' : 'Confirmar'}
              </Button>
              <Button variant="outline" size="sm" disabled={pendente} onClick={() => setConfirmando(null)}>
                Cancelar
              </Button>
            </>
          ) : confirmando === 'todas' ? (
            <>
              <span className="text-xs text-muted-foreground">
                Limpar a memória de TODAS as conversas?
              </span>
              <Button
                variant="destructive"
                size="sm"
                disabled={pendente}
                onClick={() => executar('todas')}
              >
                {pendente ? 'Limpando…' : 'Confirmar todas'}
              </Button>
              <Button variant="outline" size="sm" disabled={pendente} onClick={() => setConfirmando(null)}>
                Cancelar
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="outline"
                size="sm"
                disabled={pendente || nSel === 0}
                onClick={() => setConfirmando('selecao')}
              >
                <Eraser className="h-4 w-4" aria-hidden /> Limpar memória ({nSel})
              </Button>
              {/* Ação global (todas as conversas): separada e rotulada por extenso
                  para não se confundir com o "limpar" da seleção acima. */}
              <span className="mx-1 h-5 w-px bg-border" aria-hidden />
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                disabled={pendente}
                onClick={() => setConfirmando('todas')}
              >
                Limpar memória de todas
              </Button>
            </>
          )}
        </div>
      </div>

      {feedback.erro ? (
        <Alert variant="destructive" className="mt-3">
          {feedback.erro}
        </Alert>
      ) : null}
      {feedback.sucesso ? (
        <Alert variant="success" className="mt-3">
          {feedback.sucesso}
        </Alert>
      ) : null}

      <div className="mt-2 flex items-center gap-4 border-b border-border pb-2 text-xs font-medium text-muted-foreground">
        <span className="w-4 shrink-0" aria-hidden />
        <span className="flex-1">Contato</span>
        <span className="w-20">Situação</span>
        <span className="w-32 text-right">Última atividade</span>
      </div>

      {conversas.map((c) => (
        <div
          key={c.conversation_id}
          className="flex items-center gap-4 border-b border-border py-3 text-sm transition-colors hover:bg-muted/50"
        >
          <input
            type="checkbox"
            className="h-4 w-4 shrink-0 cursor-pointer accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            checked={selecao.has(c.conversation_id)}
            onChange={() => alternar(c.conversation_id)}
            aria-label={`Selecionar conversa de ${c.contact_name ?? 'sem nome'}`}
          />
          <Link
            href={`/painel/conversas/${c.conversation_id}`}
            className="flex min-w-0 flex-1 items-center gap-4"
          >
            <span className="min-w-0 flex-1 truncate">
              <span className="font-medium">{c.contact_name ?? 'Sem nome'}</span>
              {c.phone ? <span className="ml-2 text-muted-foreground">{c.phone}</span> : null}
            </span>
            <span className="w-20">
              <StatusBadge status_efetivo={c.status_efetivo} motivo_pausa={c.motivo_pausa} pausa_expira_em={c.pausa_expira_em} />
            </span>
            <span className="w-32 text-right text-muted-foreground">
              {dataCurta(c.atualizado_em)}
            </span>
          </Link>
        </div>
      ))}
    </div>
  );
}
