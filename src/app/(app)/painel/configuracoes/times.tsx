'use client';

import { useActionState, useState } from 'react';

import { excluirTime, salvarTime, verificarTimeSalvo, type EstadoConfig } from '../acoes';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SubmitButton } from '@/components/ui/submit-button';
import { Textarea } from '@/components/ui/textarea';
import { MAX_DESCRICAO, MAX_DESCRICAO_TOTAL } from '@/lib/tools/times-chatwoot';

export type TimeDaTela = {
  id: string;
  team_id: number | string;
  nome: string;
  descricao: string;
  padrao: boolean;
  verificado_em: string | null;
  falhou_em: string | null;
};

function ErroCampo({ msg }: { msg?: string }) {
  if (!msg) return null;
  return <p className="text-xs text-destructive">{msg}</p>;
}

/**
 * Estado de um time, do jeito que o cliente precisa ler.
 *
 * `falhou_em` preenchido é o caso que importa: o time existia no cadastro e
 * sumiu do Chatwoot depois. Sem este selo, a transferência volta a ser
 * silenciosa — cai no padrão e ninguém fica sabendo.
 */
function Selo({ time }: { time: TimeDaTela }) {
  // Os dois "não" precisam de peso diferente: `falhou_em` é PROBLEMA (o time
  // sumiu e a transferência está caindo no padrão), enquanto "não verificado" é
  // apenas ausência de teste. Com o mesmo selo, o problema se esconde no meio.
  if (time.falhou_em) return <Badge variant="warning">não encontrado no Chatwoot</Badge>;
  if (time.verificado_em) return <Badge variant="success">confirmado</Badge>;
  return <Badge variant="outline">não verificado</Badge>;
}

function LinhaTime({ time }: { time: TimeDaTela }) {
  const [estadoV, acaoV] = useActionState<EstadoConfig, FormData>(verificarTimeSalvo, {});
  const [estadoE, acaoE] = useActionState<EstadoConfig, FormData>(excluirTime, {});
  const [confirmando, setConfirmando] = useState(false);

  return (
    <div className="flex flex-col gap-2 border-t border-border py-3 first:border-0">
      {estadoV.erro ? <Alert variant="destructive">{estadoV.erro}</Alert> : null}
      {estadoV.sucesso ? <Alert variant="success">{estadoV.sucesso}</Alert> : null}
      {estadoE.erro ? <Alert variant="destructive">{estadoE.erro}</Alert> : null}

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{time.nome}</span>
            <Badge variant="secondary">time {String(time.team_id)}</Badge>
            {time.padrao ? <Badge>padrão</Badge> : null}
            <Selo time={time} />
          </div>
          {time.descricao ? (
            <p className="mt-0.5 text-xs text-muted-foreground">{time.descricao}</p>
          ) : null}
        </div>

        <div className="flex items-center gap-2">
          <form action={acaoV}>
            <input type="hidden" name="id" value={time.id} />
            <SubmitButton variant="ghost" size="sm" pendingLabel="Verificando…">
              Verificar
            </SubmitButton>
          </form>
          {confirmando ? (
            <form action={acaoE} className="flex items-center gap-2">
              <input type="hidden" name="id" value={time.id} />
              <span className="text-xs text-muted-foreground">Remover?</span>
              <SubmitButton variant="destructive" size="sm" pendingLabel="Removendo…">
                Confirmar
              </SubmitButton>
              <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmando(false)}>
                Não
              </Button>
            </form>
          ) : (
            <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmando(true)}>
              Remover
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

export function Times({ times, contaChatwoot }: { times: TimeDaTela[]; contaChatwoot: string | null }) {
  const [estado, acao] = useActionState<EstadoConfig, FormData>(salvarTime, {});
  const [descricao, setDescricao] = useState('');

  const usados = times.reduce((a, t) => a + t.descricao.length, 0);
  const restante = MAX_DESCRICAO_TOTAL - usados - descricao.length;
  const semPadrao = times.length > 0 && !times.some((t) => t.padrao);

  return (
    <div className="flex flex-col gap-4">
      {times.length > 0 ? (
        <div className="flex flex-col">
          {times.map((t) => (
            <LinhaTime key={t.id} time={t} />
          ))}
        </div>
      ) : null}

      {/*
        Sem padrão, um nome que o agente invente não tem para onde ir e a
        transferência falha calada. É o buraco que o desenho inteiro existe para
        fechar, então o aviso é o mais forte da tela.
      */}
      {semPadrao ? (
        <Alert variant="warning">
          Nenhum time está marcado como <strong>padrão</strong>. Quando o agente não souber
          escolher, a conversa fica sem time — marque um.
        </Alert>
      ) : null}

      <form action={acao} className="flex flex-col gap-4 rounded-xl border border-border p-4">
        {estado.erro ? <Alert variant="destructive">{estado.erro}</Alert> : null}
        {estado.sucesso ? <Alert variant="success">{estado.sucesso}</Alert> : null}

        <div className="flex flex-wrap gap-4">
          <div className="flex w-32 flex-col gap-2">
            <Label htmlFor="team_id">Número do time</Label>
            <Input id="team_id" name="team_id" inputMode="numeric" placeholder="20" required />
            <ErroCampo msg={estado.errosCampo?.['team_id']} />
          </div>
          <div className="flex min-w-48 flex-1 flex-col gap-2">
            <Label htmlFor="nome">Nome</Label>
            <Input id="nome" name="nome" placeholder="Ex.: suporte" maxLength={40} required />
            <ErroCampo msg={estado.errosCampo?.['nome']} />
          </div>
        </div>

        {/*
          ONDE ACHAR O NÚMERO. Sem isto o formulário não pode ser preenchido, e
          vira chamado de suporte toda vez — o bot não lista os times, então não
          há como oferecer uma lista para escolher.
        */}
        <p className="-mt-1 text-xs text-muted-foreground">
          No Chatwoot: <strong>Configurações → Times → clicar no time</strong>. O número é o
          final do endereço —{' '}
          <code className="rounded bg-muted px-1">
            /accounts/{contaChatwoot ?? '1'}/settings/teams/<strong>20</strong>/edit
          </code>
        </p>

        <div className="flex flex-col gap-2">
          <Label htmlFor="descricao">Quando o agente deve escolher este time</Label>
          <Textarea
            id="descricao"
            name="descricao"
            rows={2}
            maxLength={MAX_DESCRICAO}
            value={descricao}
            onChange={(e) => setDescricao(e.target.value)}
            placeholder="Ex.: quando o cliente já comprou e tem problema com o produto."
          />
          {/*
            DOIS CONTADORES, e o do conjunto é o que importa: quinze descrições
            de 80 passam em qualquer limite por campo e custam o dobro de seis de
            120. É a soma que entra no prompt a cada mensagem.
          */}
          <div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
            <span>
              {descricao.length}/{MAX_DESCRICAO} nesta
            </span>
            <span className={restante < 0 ? 'font-medium text-destructive' : undefined}>
              {usados + descricao.length} de {MAX_DESCRICAO_TOTAL} no total — o agente lê todas
              a cada mensagem
            </span>
          </div>
          <ErroCampo msg={estado.errosCampo?.['descricao']} />
        </div>

        <label className="flex items-center gap-3">
          <input
            type="checkbox"
            name="padrao"
            className="h-4 w-4 accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          />
          <span className="text-sm">Usar este quando o agente não souber escolher</span>
        </label>

        <div>
          <SubmitButton pendingLabel="Verificando no Chatwoot…" disabled={restante < 0}>
            Adicionar time
          </SubmitButton>
        </div>
      </form>

      {/*
        MENCIONA, NÃO GERENCIA. Com token de bot não dá para ler nem alterar
        `allow_auto_assign` — prometer controle sobre o que não se controla é
        pior que não mencionar.
      */}
      <p className="text-xs text-muted-foreground">
        No Chatwoot, cada time tem <strong>distribuição automática</strong>. Ligada, a conversa
        cai no colo de um atendente do time; desligada, fica na fila do time esperando alguém
        pegar. Isso se ajusta lá, não aqui.
      </p>
    </div>
  );
}
