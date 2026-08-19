'use client';

import { useActionState, useEffect, useState } from 'react';

import { excluirTime, salvarTime, verificarTimeSalvo, type EstadoConfig } from '../acoes';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SubmitButton } from '@/components/ui/submit-button';
import { Textarea } from '@/components/ui/textarea';
import { MAX_DESCRICAO, MAX_DESCRICAO_TOTAL, timeUtilizavel } from '@/lib/tools/times-chatwoot';

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
            <SubmitButton
              variant="ghost"
              size="sm"
              pendingLabel="Verificando…"
              title="Atribui e desatribui este time numa conversa existente do Chatwoot."
            >
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

  /*
   * LIMPAR A DESCRIÇÃO NO SUCESSO. `team_id`, `nome` e o checkbox são campos
   * não controlados, e o React 19 limpa o formulário sozinho ao fim da action;
   * `descricao` é controlada por este estado, e sobrevivia. Dois estragos: o
   * time seguinte nascia com a descrição do anterior já escrita — ninguém
   * revisa campo que parece preenchido de propósito — e o contador do conjunto
   * somava o salvo MAIS o rascunho remanescente, podendo acusar “passou de
   * 720” sem ter passado.
   *
   * SÓ no sucesso, e a assimetria que sobra é DECISÃO EM ABERTO, não descuido:
   * no erro o React limpa número e nome e esta descrição fica. Ou seja, quem
   * recebe “o Chatwoot não tem o time 9999” perde justamente o campo que o erro
   * mandou corrigir. Fechar isso exige escolher entre preservar os três
   * (controlá-los todos) ou limpar os três — e as duas mexem no que o cliente
   * vê depois de errar. Não é conserto mecânico, então não entrou junto.
   */
  useEffect(() => {
    if (estado.sucesso) setDescricao('');
  }, [estado]);

  const usados = times.reduce((a, t) => a + t.descricao.length, 0);
  const restante = MAX_DESCRICAO_TOTAL - usados - descricao.length;
  /*
   * "TER PADRÃO MARCADO" E "TER PADRÃO QUE FUNCIONA" SÃO COISAS DIFERENTES, e a
   * tela só sabia a primeira. Depois da migração 45, `api_n8n_times` não devolve
   * time sem selo — então um padrão marcado e não verificado é um padrão que o
   * agente nunca vai usar, e o aviso antigo ficava CALADO nesse caso, afirmando
   * por omissão que estava tudo certo. Pior que mentir por texto: texto alguém
   * relê, silêncio ninguém revisa.
   *
   * `timeUtilizavel` é a mesma regra da migração, com um nome só, para as duas
   * metades não divergirem de novo.
   */
  const padraoMarcado = times.some((t) => t.padrao);
  const padraoUtilizavel = times.some((t) => t.padrao && timeUtilizavel(t));

  const semPadrao = times.length > 0 && !padraoMarcado;
  const padraoSemSelo = times.length > 0 && padraoMarcado && !padraoUtilizavel;

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
        DIZIA QUE A TRANSFERÊNCIA "FALHA CALADA" SEM PADRÃO, e isso deixou de ser
        verdade quando o desenho fechou. O modelo NÃO escolhe time nesta versão:
        o sub-workflow pega o `padrao` e, não havendo, manda `time_id: null` —
        a conversa é pausada e entregue na inbox, que é o que todo cliente teve
        até agora. Não há nome inventado sem destino porque não há nome
        inventado.

        O aviso continua valendo, com o peso certo: o que se perde sem padrão é
        o roteamento fino, não o atendimento. Por isso o texto passa a dizer o
        que CONTINUA funcionando antes de dizer o que falta — aviso que exagera
        a consequência ensina a ignorar avisos.
      */}
      {semPadrao ? (
        <Alert variant="warning">
          Nenhum time está marcado como <strong>padrão</strong>. A transferência continua
          funcionando — o agente pausa e a conversa espera na caixa de entrada —, mas ela
          não vai para nenhum time. Marque um para o atendimento cair no time certo.
        </Alert>
      ) : null}

      {/*
        AVISO PRÓPRIO, e não uma frase a mais no de cima: a causa é outra e a
        SAÍDA é outra. Marcar outro time não resolve nada aqui — o que resolve é
        confirmar o número, ou conectar a conta antes disso. Colapsar os dois na
        mesma frase mandaria o cliente mexer no lugar errado, que é a classe de
        defeito que esta tela inteira vem consertando.

        E os dois são mutuamente exclusivos por construção: o de cima exige
        nenhum padrão marcado, este exige um marcado.
      */}
      {padraoSemSelo ? (
        <Alert variant="warning">
          O time padrão ainda não foi confirmado no Chatwoot, então o agente{' '}
          <strong>não vai usá-lo</strong> — a transferência continua funcionando, mas a
          conversa fica sem time.{' '}
          {contaChatwoot ? (
            <>
              Clique em <strong>Verificar</strong> na linha dele.
            </>
          ) : (
            <>
              Este cliente ainda não está conectado a uma conta do Chatwoot, e sem isso não
              há como confirmar — fale com a agência.
            </>
          )}
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
            120.

            O TOTAL CONTA TODAS AS DESCRIÇÕES, e isso não é descuido: quem impõe
            os 720 é o trigger no banco, que soma todas as linhas de
            `tenant_times` — com selo ou sem. O cálculo daqui é o mesmo do
            trigger de propósito; divergir faria a tela aceitar o que a
            constraint recusa.

            O que mudou foi a EXPLICAÇÃO. Ela dizia "é a soma que entra no prompt
            a cada mensagem", e com a migração 45 quem chega ao agente é só o
            time confirmado. As duas convivem sem contradição: o teto é sobre o
            que PODE custar prompt, o selo é sobre o que efetivamente vai. O
            texto diz as duas — dizer só a segunda sugeriria que o número está
            errado, e ele não está.
          */}
          <div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
            <span>
              {descricao.length}/{MAX_DESCRICAO} nesta
            </span>
            <span className={restante < 0 ? 'font-medium text-destructive' : undefined}>
              {usados + descricao.length} de {MAX_DESCRICAO_TOTAL} no total — o teto vale para
              todas; o agente lê as dos times confirmados
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
      {/*
        DIZER O QUE A VERIFICAÇÃO FAZ, e não só que ela existe.
        `verificarTime` desfaz com `team_id: null` — não com o time que estava
        antes —, porque o bot não consegue LER a conversa para saber qual era
        (`GET /conversations` é 401, medido). Enquanto o alvo era "a mais antiga
        já encerrada" isso era teórico; com o critério novo (a menos
        recentemente tocada, qualquer status) a conversa escolhida pode ter time,
        e a verificação o apaga. Não há conserto possível — o conserto é avisar.
      */}
      <p className="text-xs text-muted-foreground">
        <strong>Verificar</strong> atribui e desatribui o time numa conversa existente do seu
        Chatwoot, para confirmar que o número existe. Se aquela conversa já tiver um time, ele
        sai — reatribua por lá se precisar.
      </p>

      <p className="text-xs text-muted-foreground">
        No Chatwoot, cada time tem <strong>distribuição automática</strong>. Ligada, a conversa
        cai no colo de um atendente do time; desligada, fica na fila do time esperando alguém
        pegar. Isso se ajusta lá, não aqui.
      </p>
    </div>
  );
}
