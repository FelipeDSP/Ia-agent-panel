'use client';

import { useActionState, useState } from 'react';

import {
  alternarSuspensaoTenant,
  conectarChatwoot,
  convidarAdminTenant,
  editarNomeAdmin,
  editarTenantSuper,
  excluirTenant,
  removerAdmin,
  reenviarAcessoAdmin,
  salvarTransferirHumanoAgencia,
  type EstadoAcao,
} from '../../acoes';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { SubmitButton } from '@/components/ui/submit-button';
import { Textarea } from '@/components/ui/textarea';
import { MODELOS_PERMITIDOS } from '@/lib/tenants/schema';

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

      <div>
        <SubmitButton pendingLabel="Validando…">
          {accountId ? 'Revalidar e salvar' : 'Conectar'}
        </SubmitButton>
      </div>
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
        <div className="flex flex-col gap-2 rounded-md border border-border bg-muted/50 p-3">
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
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-2">
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
        <div className="flex flex-col gap-2 rounded-md border border-border bg-muted/50 p-3">
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
