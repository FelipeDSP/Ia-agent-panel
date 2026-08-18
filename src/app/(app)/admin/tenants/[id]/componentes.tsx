'use client';

import { useActionState, useState } from 'react';

import {
  alternarSuspensaoTenant,
  conectarChatwoot,
  convidarAdminTenant,
  definirContratacao,
  desconectarChatwoot,
  editarNomeAdmin,
  editarTenantSuper,
  excluirTenant,
  removerAdmin,
  reenviarAcessoAdmin,
  salvarTransferirHumanoAgencia,
  type EstadoAcao,
} from '../../acoes';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { SubmitButton } from '@/components/ui/submit-button';
import { Textarea } from '@/components/ui/textarea';
import { MODELOS_PERMITIDOS } from '@/lib/tenants/schema';
import { secaoPadraoTemAnomalia } from '@/lib/tools/registro';
import type { GrupoTool } from '@/lib/tools/tipos';

function ErroCampo({ msg }: { msg?: string }) {
  if (!msg) return null;
  return <p className="text-xs text-destructive">{msg}</p>;
}

// --- Configuração (super admin: modelo, temperatura, debounce, nome) ---------

export function FormConfigSuper({
  tenantId,
  nome,
  modelo,
  temperatura,
  debounce,
}: {
  tenantId: string;
  nome: string;
  modelo: string;
  temperatura: number;
  debounce: number;
}) {
  const [estado, acao] = useActionState<EstadoAcao, FormData>(editarTenantSuper, {});

  return (
    <form action={acao} className="flex flex-col gap-4">
      <input type="hidden" name="tenant_id" value={tenantId} />

      {estado.erro ? <Alert variant="destructive">{estado.erro}</Alert> : null}
      {estado.sucesso ? <Alert variant="success">{estado.sucesso}</Alert> : null}

      <div className="flex flex-col gap-2">
        <Label htmlFor="nome">Nome</Label>
        <Input id="nome" name="nome" defaultValue={nome} />
        <ErroCampo msg={estado.errosCampo?.['nome']} />
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="flex flex-col gap-2">
          <Label htmlFor="modelo">Modelo</Label>
          <Select id="modelo" name="modelo" defaultValue={modelo}>
            {MODELOS_PERMITIDOS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="temperatura">Temperatura</Label>
          <Input
            id="temperatura"
            name="temperatura"
            type="number"
            step="0.05"
            min="0"
            max="2"
            defaultValue={temperatura}
          />
          <ErroCampo msg={estado.errosCampo?.['temperatura']} />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="debounce_segundos">Debounce (s)</Label>
          <Input
            id="debounce_segundos"
            name="debounce_segundos"
            type="number"
            min="1"
            max="60"
            defaultValue={debounce}
          />
          <ErroCampo msg={estado.errosCampo?.['debounce_segundos']} />
        </div>
      </div>

      <div>
        <SubmitButton>Salvar configuração</SubmitButton>
      </div>
    </form>
  );
}

// --- Conexão Chatwoot --------------------------------------------------------

export function FormChatwoot({
  tenantId,
  accountId,
  url,
}: {
  tenantId: string;
  accountId: number | null;
  url: string;
}) {
  const [estado, acao] = useActionState<EstadoAcao, FormData>(conectarChatwoot, {});

  return (
    <div className="flex flex-col gap-4">
      <form action={acao} className="flex flex-col gap-4">
        <input type="hidden" name="tenant_id" value={tenantId} />

        {estado.erro ? <Alert variant="destructive">{estado.erro}</Alert> : null}
        {estado.sucesso ? <Alert variant="success">{estado.sucesso}</Alert> : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-2">
            <Label htmlFor="chatwoot_account_id">account_id</Label>
            <Input
              id="chatwoot_account_id"
              name="chatwoot_account_id"
              type="number"
              min="1"
              defaultValue={accountId ?? ''}
            />
            <ErroCampo msg={estado.errosCampo?.['chatwoot_account_id']} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="chatwoot_url">URL</Label>
            <Input id="chatwoot_url" name="chatwoot_url" defaultValue={url} />
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="chatwoot_token">Token (api_access_token)</Label>
          <Input
            id="chatwoot_token"
            name="chatwoot_token"
            type="password"
            autoComplete="off"
            placeholder={accountId ? '•••••• (deixe para revalidar)' : ''}
          />
          <ErroCampo msg={estado.errosCampo?.['chatwoot_token']} />
          <p className="text-xs text-muted-foreground">
            O token é validado com uma chamada real ao Chatwoot antes de salvar.
          </p>
        </div>

        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            name="token_bot"
            className="mt-0.5 h-4 w-4 accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          />
          <span>
            É um token de Agent Bot (o robô responde por ele)
            <span className="mt-0.5 block text-xs text-muted-foreground">
              Marque se o token veio de um Agent Bot. Esse tipo não é validado pela API de conta
              (daria 401) — o painel salva sem validar e você confirma com uma mensagem de teste.
            </span>
          </span>
        </label>

        <div>
          <SubmitButton pendingLabel="Validando…">
            {accountId ? 'Revalidar e salvar' : 'Conectar'}
          </SubmitButton>
        </div>
      </form>

      {/* Irmao, nao filho: form aninhado e HTML invalido, e o React
          desmonta em silencio. */}
      {accountId ? <DesconectarChatwoot tenantId={tenantId} accountId={accountId} /> : null}
    </div>
  );
}

/**
 * Desconectar: libera a conta do Chatwoot para outro cliente.
 *
 * Só aparece quando HÁ conta conectada — botão que não tem o que fazer é ruído,
 * e a Server Action recusa esse caso de qualquer forma.
 *
 * A confirmação não é cerimônia. "Desconectar" soa destrutivo, e o que a pessoa
 * precisa saber divide-se em três, nesta ordem: o que PARA (o atendimento), o
 * que FICA (o token) e o que NÃO é tocado (o dado do cliente). Sem a terceira,
 * quem precisa trocar a conta hesita — e hesitar aqui significa voltar a fazer
 * por SQL, que é o que motivou este botão.
 */
function DesconectarChatwoot({ tenantId, accountId }: { tenantId: string; accountId: number }) {
  const [estado, acao] = useActionState<EstadoAcao, FormData>(desconectarChatwoot, {});
  const [confirmando, setConfirmando] = useState(false);

  return (
    <form action={acao} className="flex flex-col gap-3 border-t border-border pt-4">
      <input type="hidden" name="tenant_id" value={tenantId} />

      {estado.erro ? <Alert variant="destructive">{estado.erro}</Alert> : null}
      {estado.sucesso ? <Alert variant="success">{estado.sucesso}</Alert> : null}

      {confirmando ? (
        <Alert variant="warning">
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <span>
                <strong>O agente deste cliente para de responder.</strong> A mensagem continua
                chegando do Chatwoot, mas morre na checagem de tenant — sem erro visível para
                quem escreveu.
              </span>
              <span>
                <strong>O token continua guardado.</strong> Reconectar este mesmo cliente não
                exige gerar token novo no Chatwoot.
              </span>
              <span>
                <strong>Nada é apagado.</strong> Conversas, produtos, base de conhecimento e
                pedidos ficam como estão.
              </span>
            </div>
            {/*
              DUAS SAÍDAS, porque são dois casos diferentes — e a diferença não
              é de grau: guardar o token só ajuda enquanto ele VALE. Se o Agent
              Bot mudou ou o token foi regenerado no Chatwoot, o guardado virou
              lixo, e lixo aqui não dá erro ao reconectar: o agente processa o
              turno e falha no envio, calado.

              A linha entre os botões existe para a escolha ser feita pelo CASO
              ("troquei de conta" x "o bot mudou") e não pelo grau de medo.
            */}
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <SubmitButton pendingLabel="Desconectando…">
                  Desconectar a conta {accountId}
                </SubmitButton>
                <SubmitButton
                  name="apagar_credencial"
                  value="1"
                  variant="outline"
                  pendingLabel="Desconectando…"
                >
                  Desconectar e apagar a credencial
                </SubmitButton>
                <Button type="button" variant="ghost" onClick={() => setConfirmando(false)}>
                  Cancelar
                </Button>
              </div>
              <p className="text-xs">
                A primeira é para <strong>trocar a conta de cliente</strong> — o token continua
                valendo. A segunda é para quando <strong>o bot mudou ou o token foi
                regenerado</strong>: aí o guardado só atrapalha, e reconectar vai pedir um novo.
              </p>
            </div>
          </div>
        </Alert>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" variant="outline" onClick={() => setConfirmando(true)}>
            Desconectar Chatwoot
          </Button>
          <span className="text-xs text-muted-foreground">
            Libera a conta {accountId} para outro cliente. O token fica guardado.
          </span>
        </div>
      )}
    </form>
  );
}

// --- Tool: transferência para humano (infra, super admin) -------------------

export function FormTransferirHumano({
  tenantId,
  descricao,
  sessao,
  habilitada,
}: {
  tenantId: string;
  descricao: string;
  sessao: string;
  habilitada: boolean;
}) {
  const [estado, acao] = useActionState<EstadoAcao, FormData>(
    salvarTransferirHumanoAgencia,
    {},
  );

  return (
    <form action={acao} className="flex flex-col gap-4">
      <input type="hidden" name="tenant_id" value={tenantId} />

      {estado.erro ? <Alert variant="destructive">{estado.erro}</Alert> : null}
      {estado.sucesso ? <Alert variant="success">{estado.sucesso}</Alert> : null}

      <div className="flex flex-col gap-2">
        <Label htmlFor="descricao">Descrição da tool (ensina a IA quando transferir)</Label>
        <Textarea id="descricao" name="descricao" rows={3} defaultValue={descricao} />
        <ErroCampo msg={estado.errosCampo?.['descricao']} />
      </div>

      <div className="flex max-w-sm flex-col gap-2">
        <Label htmlFor="sessao">Sessão WAHA (opcional)</Label>
        <Input
          id="sessao"
          name="sessao"
          defaultValue={sessao}
          placeholder="ex.: acquaariquemes (vazio = sem aviso)"
        />
        <p className="text-xs text-muted-foreground">
          Por qual sessão do WAHA sai o aviso. Vazio = o cliente não consegue ligar o aviso, mas a
          transferência (nota + pausa) funciona mesmo assim.
        </p>
      </div>

      <div>
        <SubmitButton>{habilitada ? 'Salvar tool' : 'Habilitar tool'}</SubmitButton>
      </div>
    </form>
  );
}

// --- Convite do admin do cliente --------------------------------------------

export function FormConvite({ tenantId }: { tenantId: string }) {
  const [estado, acao] = useActionState<EstadoAcao, FormData>(convidarAdminTenant, {});
  const [copiado, setCopiado] = useState(false);

  return (
    <form action={acao} className="flex flex-col gap-4">
      <input type="hidden" name="tenant_id" value={tenantId} />

      {estado.erro ? <Alert variant="destructive">{estado.erro}</Alert> : null}
      {estado.sucesso ? <Alert variant="success">{estado.sucesso}</Alert> : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor="email">Email do admin</Label>
          <Input id="email" name="email" type="email" required />
          <ErroCampo msg={estado.errosCampo?.['email']} />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="nome">Nome</Label>
          <Input id="nome" name="nome" />
        </div>
      </div>

      <div>
        <SubmitButton pendingLabel="Convidando…">Convidar admin</SubmitButton>
      </div>

      {estado.linkConvite ? (
        <div className="flex flex-col gap-2 rounded-xl border border-border bg-muted/50 p-3">
          <p className="text-xs text-muted-foreground">
            SMTP ainda não configurado — envie este link ao cliente para ele
            definir a senha:
          </p>
          <div className="flex items-center gap-2">
            <Input readOnly value={estado.linkConvite} className="font-mono text-xs" />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                void navigator.clipboard.writeText(estado.linkConvite ?? '');
                setCopiado(true);
              }}
            >
              {copiado ? 'Copiado' : 'Copiar'}
            </Button>
          </div>
        </div>
      ) : null}
    </form>
  );
}

// --- Suspender / reativar ----------------------------------------------------

export function BotaoSuspensao({ tenantId, ativo }: { tenantId: string; ativo: boolean }) {
  const [estado, acao] = useActionState<EstadoAcao, FormData>(alternarSuspensaoTenant, {});

  return (
    <form action={acao} className="flex flex-col gap-2">
      <input type="hidden" name="tenant_id" value={tenantId} />
      <input type="hidden" name="suspender" value={ativo ? 'true' : 'false'} />

      {estado.erro ? <Alert variant="destructive">{estado.erro}</Alert> : null}
      {estado.sucesso ? <Alert variant="success">{estado.sucesso}</Alert> : null}

      <div>
        <SubmitButton variant={ativo ? 'destructive' : 'default'} pendingLabel="Aplicando…">
          {ativo ? 'Suspender cliente' : 'Reativar cliente'}
        </SubmitButton>
      </div>
      <p className="text-xs text-muted-foreground">
        {ativo
          ? 'Suspenso, o agente para de responder (api_n8n filtra por ativo).'
          : 'Reativar volta a permitir que o agente responda.'}
      </p>
    </form>
  );
}

// --- Gestão de admins do cliente --------------------------------------------

type AdminResumo = { id: string; email: string; nome: string };

export function GerenciarAdmins({
  tenantId,
  admins,
}: {
  tenantId: string;
  admins: AdminResumo[];
}) {
  if (admins.length === 0) {
    return <p className="text-sm text-muted-foreground">Nenhum admin vinculado ainda.</p>;
  }
  return (
    <ul className="flex flex-col divide-y divide-border">
      {admins.map((a) => (
        <li key={a.id} className="py-3 first:pt-0 last:pb-0">
          <LinhaAdmin tenantId={tenantId} admin={a} />
        </li>
      ))}
    </ul>
  );
}

function LinhaAdmin({ tenantId, admin }: { tenantId: string; admin: AdminResumo }) {
  const [estadoEditar, acaoEditar] = useActionState<EstadoAcao, FormData>(editarNomeAdmin, {});
  const [estadoLink, acaoLink] = useActionState<EstadoAcao, FormData>(reenviarAcessoAdmin, {});
  const [estadoRemover, acaoRemover] = useActionState<EstadoAcao, FormData>(removerAdmin, {});
  const [editando, setEditando] = useState(false);
  const [confirmando, setConfirmando] = useState(false);
  const [copiado, setCopiado] = useState(false);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <span className="font-medium">{admin.nome}</span>
          <span className="ml-2 text-sm text-muted-foreground">{admin.email}</span>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => setEditando((v) => !v)}>
            {editando ? 'Fechar' : 'Editar'}
          </Button>
          <form action={acaoLink}>
            <input type="hidden" name="tenant_id" value={tenantId} />
            <input type="hidden" name="user_id" value={admin.id} />
            <SubmitButton variant="outline" size="sm" pendingLabel="Gerando…">
              Reenviar link
            </SubmitButton>
          </form>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            onClick={() => setConfirmando(true)}
          >
            Remover
          </Button>
        </div>
      </div>

      {estadoEditar.erro ? <Alert variant="destructive">{estadoEditar.erro}</Alert> : null}
      {estadoEditar.sucesso ? <Alert variant="success">{estadoEditar.sucesso}</Alert> : null}
      {estadoRemover.erro ? <Alert variant="destructive">{estadoRemover.erro}</Alert> : null}
      {estadoRemover.sucesso ? <Alert variant="success">{estadoRemover.sucesso}</Alert> : null}
      {estadoLink.erro ? <Alert variant="destructive">{estadoLink.erro}</Alert> : null}

      {editando ? (
        <form action={acaoEditar} className="flex items-end gap-2">
          <input type="hidden" name="tenant_id" value={tenantId} />
          <input type="hidden" name="user_id" value={admin.id} />
          <div className="flex flex-1 flex-col gap-1">
            <Label htmlFor={`nome-${admin.id}`}>Nome</Label>
            <Input id={`nome-${admin.id}`} name="nome" defaultValue={admin.nome} />
            <ErroCampo msg={estadoEditar.errosCampo?.['nome']} />
          </div>
          <SubmitButton size="sm" pendingLabel="Salvando…">
            Salvar
          </SubmitButton>
        </form>
      ) : null}

      {confirmando ? (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-destructive/40 bg-destructive/5 p-2">
          <span className="text-sm">
            Remover <b>{admin.email}</b>? Isso revoga o acesso dele imediatamente.
          </span>
          <form action={acaoRemover}>
            <input type="hidden" name="tenant_id" value={tenantId} />
            <input type="hidden" name="user_id" value={admin.id} />
            <SubmitButton variant="destructive" size="sm" pendingLabel="Removendo…">
              Confirmar remoção
            </SubmitButton>
          </form>
          <Button type="button" variant="outline" size="sm" onClick={() => setConfirmando(false)}>
            Cancelar
          </Button>
        </div>
      ) : null}

      {estadoLink.sucesso && estadoLink.linkConvite ? (
        <div className="flex flex-col gap-2 rounded-xl border border-border bg-muted/50 p-3">
          <p className="text-xs text-muted-foreground">
            Envie este link ao admin para ele (re)definir a senha:
          </p>
          <div className="flex items-center gap-2">
            <Input readOnly value={estadoLink.linkConvite} className="font-mono text-xs" />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                void navigator.clipboard.writeText(estadoLink.linkConvite ?? '');
                setCopiado(true);
              }}
            >
              {copiado ? 'Copiado' : 'Copiar'}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// --- Excluir cliente (zona de perigo) ---------------------------------------

export function ZonaPerigoExcluir({ tenantId, nome }: { tenantId: string; nome: string }) {
  const [estado, acao] = useActionState<EstadoAcao, FormData>(excluirTenant, {});
  const [confirmacao, setConfirmacao] = useState('');

  // Habilita o botão só quando o texto bate com o nome. O servidor revalida
  // isso de qualquer forma; aqui é só para evitar clique acidental.
  const podeExcluir = confirmacao.trim() === nome.trim();

  return (
    <form action={acao} className="flex flex-col gap-3">
      <input type="hidden" name="tenant_id" value={tenantId} />

      {estado.erro ? <Alert variant="destructive">{estado.erro}</Alert> : null}

      <p className="text-sm text-muted-foreground">
        Excluir remove o cliente da lista e desliga o agente. É reversível
        (soft delete — o dado fica no banco), mas a restauração é feita pela
        agência sob demanda. Não apaga conversas nem documentos.
      </p>

      <div className="flex flex-col gap-2">
        <Label htmlFor="confirmacao">
          Para confirmar, digite o nome do cliente:{' '}
          <span className="font-medium text-foreground">{nome}</span>
        </Label>
        <Input
          id="confirmacao"
          name="confirmacao"
          autoComplete="off"
          value={confirmacao}
          onChange={(e) => setConfirmacao(e.target.value)}
          placeholder={nome}
        />
        <ErroCampo msg={estado.errosCampo?.['confirmacao']} />
      </div>

      <div>
        <SubmitButton variant="destructive" disabled={!podeExcluir} pendingLabel="Excluindo…">
          Excluir cliente
        </SubmitButton>
      </div>
    </form>
  );
}

// --- Módulos (tools) do tenant: contratar / descontratar (§5.2) --------------

export type ModuloAdmin = {
  tool_nome: string;
  rotulo: string;
  resumo: string;
  temConfigCliente: boolean;
  /** Grupo derivado (registro.ts). Decide se entra na lista ou na seção recolhida. */
  grupo: GrupoTool;
  /**
   * Existe em `catalogo_tools` mas não no registry do código.
   *
   * Cai em `contratavel` de propósito — módulo recém-vendido precisa aparecer e
   * ser desligável antes de alguém escrever o rótulo. Mas rótulo e resumo vêm do
   * catálogo, não do código, e ninguém repassou o texto que o cliente lê. O
   * aviso existe porque isto se descobre pela AUSÊNCIA, e ausência não avisa.
   */
  semRegistry?: boolean;
  contratado: boolean;
  ativo: boolean;
  /**
   * Aviso de dependência entre módulos, calculado no servidor.
   *
   * Não bloqueia a contratação — só diz que o combo não faz nada. `foto_produto`
   * sem `vendas` é o caso: a tool recebe `produto_id`, e o único jeito de o
   * agente ter um é o `consultar_catalogo`, que pertence a vendas. Sem o aviso,
   * dá para vender um módulo que fica mudo, e descobrir depois.
   */
  aviso?: string | null;
};

/**
 * Módulos do cliente, vistos pela agência.
 *
 * O admin mostra o ESTADO COMPLETO — é onde se diagnostica, e diagnóstico com
 * informação escondida não é diagnóstico. O que muda é a hierarquia: em cima só
 * o que a agência vende; padrão e configurável descem para uma seção recolhida,
 * porque nenhum dos dois é decisão comercial e os dois competiam por atenção
 * com as que são.
 */
export function GestaoModulos({
  tenantId,
  modulos,
  padrao = [],
}: {
  tenantId: string;
  modulos: ModuloAdmin[];
  padrao?: ModuloAdmin[];
}) {
  if (modulos.length === 0 && padrao.length === 0) {
    return <p className="text-sm text-muted-foreground">Nenhuma tool ativa no catálogo.</p>;
  }

  // A seção recolhida ABRE SOZINHA quando há módulo padrão contratado e
  // desligado. Esse estado é invisível para o cliente e irrecuperável por ele —
  // ele não tem mais o switch —, então só a agência conserta, e só conserta o
  // que vê. Seção recolhida que esconde problema é a forma mais rápida de um
  // diagnóstico não acontecer.
  const anomalia = secaoPadraoTemAnomalia(padrao);
  const desligados = padrao.filter((m) => m.contratado && !m.ativo).length;

  return (
    <div className="flex flex-col gap-4">
      {modulos.length > 0 ? (
        <div className="flex flex-col divide-y divide-border">
          {modulos.map((m) => (
            <ModuloRow key={m.tool_nome} tenantId={tenantId} modulo={m} />
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          Nenhum módulo vendável no catálogo além do padrão do produto.
        </p>
      )}

      {padrao.length > 0 ? (
        <details open={anomalia} className="rounded-md border border-border">
          <summary className="cursor-pointer px-3 py-2 text-sm font-medium">
            Padrão do produto
            <span className="ml-2 font-normal text-muted-foreground">
              {padrao.length} {padrao.length === 1 ? 'módulo' : 'módulos'} — o cliente não
              contrata nem desliga
            </span>
            {anomalia ? (
              <span className="ml-2 font-medium text-amber-600 dark:text-amber-500">
                · {desligados} desligado{desligados === 1 ? '' : 's'}
              </span>
            ) : null}
          </summary>

          <div className="border-t border-border px-3 py-2">
            {anomalia ? (
              <p className="mb-2 text-xs font-medium text-amber-600 dark:text-amber-500">
                Módulo padrão desligado. O cliente não vê nem consegue religar pelo painel dele —
                só a agência. Se não foi intencional, religue aqui.
              </p>
            ) : null}
            <div className="flex flex-col divide-y divide-border">
              {padrao.map((m) => (
                <ModuloRow key={m.tool_nome} tenantId={tenantId} modulo={m} />
              ))}
            </div>
          </div>
        </details>
      ) : null}
    </div>
  );
}

function ModuloRow({ tenantId, modulo }: { tenantId: string; modulo: ModuloAdmin }) {
  const [estado, acao] = useActionState<EstadoAcao, FormData>(definirContratacao, {});

  return (
    <form action={acao} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
      <input type="hidden" name="tenant_id" value={tenantId} />
      <input type="hidden" name="tool_nome" value={modulo.tool_nome} />
      <input type="hidden" name="contratar" value={modulo.contratado ? 'false' : 'true'} />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium">{modulo.rotulo}</span>
            <Badge variant={modulo.contratado ? 'success' : 'secondary'}>
              {modulo.contratado ? 'contratado' : 'não contratado'}
            </Badge>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">{modulo.resumo}</p>
          {modulo.aviso ? (
            <p className="mt-1 text-xs font-medium text-amber-600 dark:text-amber-500">
              {modulo.aviso}
            </p>
          ) : null}
          {modulo.semRegistry ? (
            <p className="mt-1 text-xs font-medium text-amber-600 dark:text-amber-500">
              Sem entrada no registry do código. O cliente vê o texto do catálogo, não um rótulo
              escrito para ele, e a tool foi classificada como contratável por falta de
              informação. Registre em <code>src/lib/tools/registro.ts</code>.
            </p>
          ) : null}
        </div>
        <SubmitButton
          size="sm"
          variant={modulo.contratado ? 'destructive' : 'default'}
          pendingLabel={modulo.contratado ? 'Descontratando…' : 'Contratando…'}
        >
          {modulo.contratado ? 'Descontratar' : 'Contratar'}
        </SubmitButton>
      </div>

      {modulo.contratado ? (
        <p className="text-xs text-muted-foreground">
          {modulo.ativo
            ? 'Ligada pelo cliente.'
            : 'Aguardando o cliente ligar no painel dele.'}
          {modulo.temConfigCliente ? ' Tem configuração no painel do cliente.' : ''}
        </p>
      ) : null}

      {estado.erro ? <Alert variant="destructive">{estado.erro}</Alert> : null}
      {estado.sucesso ? <Alert variant="success">{estado.sucesso}</Alert> : null}
    </form>
  );
}
