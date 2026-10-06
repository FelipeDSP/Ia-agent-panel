'use client';

import { useActionState, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SubmitButton } from '@/components/ui/submit-button';
import { CAPACIDADES } from '@/lib/usuarios/capacidades';

import {
  convidarAgente,
  definirFuncaoDoAgente,
  excluirFuncao,
  removerAgente,
  reenviarAcessoAgente,
  salvarFuncao,
  type EstadoEquipe,
} from './acoes';

export type FuncaoDaTela = { id: string; nome: string; capacidades: string[] };
export type PessoaDaTela = {
  id: string;
  nome: string;
  email: string;
  papel: string;
  ativo: boolean;
  funcaoId: string | null;
};

function Aviso({ estado }: { estado: EstadoEquipe }) {
  return (
    <>
      {estado.erro ? <Alert variant="destructive">{estado.erro}</Alert> : null}
      {estado.sucesso ? <Alert variant="success">{estado.sucesso}</Alert> : null}
      {estado.linkConvite ? <LinkDeAcesso url={estado.linkConvite} /> : null}
    </>
  );
}

/** O link nunca é enviado por e-mail pelo painel: quem entrega é o admin. */
function LinkDeAcesso({ url }: { url: string }) {
  const [copiado, setCopiado] = useState(false);
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border bg-muted/50 p-3">
      <p className="text-xs text-muted-foreground">
        Mande este link para a pessoa definir a senha dela:
      </p>
      <div className="flex items-center gap-2">
        <Input readOnly value={url} className="font-mono text-xs" />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            void navigator.clipboard.writeText(url);
            setCopiado(true);
          }}
        >
          {copiado ? 'Copiado' : 'Copiar'}
        </Button>
      </div>
    </div>
  );
}

// --- Funções -----------------------------------------------------------------

export function Funcoes({ funcoes }: { funcoes: FuncaoDaTela[] }) {
  const [criando, setCriando] = useState(false);
  return (
    <div className="flex flex-col gap-4">
      {funcoes.map((f) => (
        <FormularioFuncao key={f.id} funcao={f} />
      ))}

      {criando ? (
        <FormularioFuncao funcao={null} aoFechar={() => setCriando(false)} />
      ) : (
        <div>
          <Button type="button" variant="outline" size="sm" onClick={() => setCriando(true)}>
            Nova função
          </Button>
        </div>
      )}
    </div>
  );
}

function FormularioFuncao({ funcao, aoFechar }: { funcao: FuncaoDaTela | null; aoFechar?: () => void }) {
  const [estado, acao] = useActionState<EstadoEquipe, FormData>(salvarFuncao, {});
  const [estadoExcluir, acaoExcluir] = useActionState<EstadoEquipe, FormData>(excluirFuncao, {});
  const [confirmando, setConfirmando] = useState(false);
  const idBase = funcao?.id ?? 'nova';

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border p-4">
      <Aviso estado={estado} />
      <Aviso estado={estadoExcluir} />

      <form action={acao} className="flex flex-col gap-4">
        {funcao ? <input type="hidden" name="funcao_id" value={funcao.id} /> : null}

        <div className="flex flex-col gap-1">
          <Label htmlFor={`nome-${idBase}`}>Nome da função</Label>
          <Input
            id={`nome-${idBase}`}
            name="nome"
            defaultValue={funcao?.nome ?? ''}
            placeholder="Vendedor"
            maxLength={40}
            className="sm:max-w-xs"
          />
          {estado.errosCampo?.['nome'] ? (
            <span className="text-sm text-destructive">{estado.errosCampo['nome']}</span>
          ) : null}
        </div>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">Esta função pode:</legend>
          {CAPACIDADES.map((c) => (
            <label key={c.chave} className="flex items-start gap-3 text-sm">
              <input
                type="checkbox"
                name="capacidades"
                value={c.chave}
                defaultChecked={funcao?.capacidades.includes(c.chave) ?? false}
                className="mt-1 h-4 w-4 shrink-0"
              />
              <span>
                <span className="font-medium">{c.rotulo}</span>
                <span className="block text-muted-foreground">{c.resumo}</span>
              </span>
            </label>
          ))}
        </fieldset>

        <div className="flex flex-wrap gap-2">
          <SubmitButton size="sm" pendingLabel="Salvando…">
            {funcao ? 'Salvar função' : 'Criar função'}
          </SubmitButton>
          {aoFechar ? (
            <Button type="button" variant="outline" size="sm" onClick={aoFechar}>
              Cancelar
            </Button>
          ) : null}
          {funcao ? (
            <Button type="button" variant="destructive" size="sm" onClick={() => setConfirmando(true)}>
              Apagar
            </Button>
          ) : null}
        </div>
      </form>

      {confirmando && funcao ? (
        <form action={acaoExcluir} className="flex flex-wrap items-center gap-2 rounded-xl border border-destructive/40 bg-destructive/5 p-2">
          <input type="hidden" name="funcao_id" value={funcao.id} />
          <span className="text-sm">
            Apagar <b>{funcao.nome}</b>? Quem tem esta função fica sem permissão nenhuma até receber
            outra — ninguém perde o acesso.
          </span>
          <SubmitButton variant="destructive" size="sm" pendingLabel="Apagando…">
            Apagar
          </SubmitButton>
          <Button type="button" variant="outline" size="sm" onClick={() => setConfirmando(false)}>
            Cancelar
          </Button>
        </form>
      ) : null}
    </div>
  );
}

// --- Pessoas -----------------------------------------------------------------

export function Equipe({
  admins,
  agentes,
  funcoes,
  lotado,
  semAcessos,
  euId,
}: {
  admins: PessoaDaTela[];
  agentes: PessoaDaTela[];
  funcoes: FuncaoDaTela[];
  lotado: boolean;
  semAcessos: boolean;
  euId: string;
}) {
  const [estado, acao] = useActionState<EstadoEquipe, FormData>(convidarAgente, {});

  return (
    <div className="flex flex-col gap-6">
      <ul className="flex flex-col divide-y divide-border">
        {admins.map((p) => (
          <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-3 first:pt-0">
            <span className="min-w-0">
              <span className="font-medium">{p.nome}</span>
              <span className="ml-2 text-sm text-muted-foreground">{p.email}</span>
            </span>
            <span className="text-xs text-muted-foreground">
              Administrador{p.id === euId ? ' (você)' : ''} · pode tudo
            </span>
          </li>
        ))}
        {agentes.map((p) => (
          <li key={p.id} className="py-3 last:pb-0">
            <LinhaAgente pessoa={p} funcoes={funcoes} />
          </li>
        ))}
      </ul>

      {agentes.length === 0 ? (
        <p className="text-sm text-muted-foreground">Ninguém da equipe convidado ainda.</p>
      ) : null}

      {semAcessos ? null : lotado ? (
        <Alert variant="warning">
          Todos os acessos contratados estão em uso. Para convidar mais alguém, remova uma pessoa ou
          fale com a agência.
        </Alert>
      ) : (
        <form action={acao} className="flex flex-col gap-4 border-t border-border pt-5">
          <p className="text-sm font-medium">Convidar alguém</p>
          <Aviso estado={estado} />
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor="email-convite">Email</Label>
              <Input id="email-convite" name="email" type="email" required />
              {estado.errosCampo?.['email'] ? (
                <span className="text-sm text-destructive">{estado.errosCampo['email']}</span>
              ) : null}
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="nome-convite">Nome</Label>
              <Input id="nome-convite" name="nome" />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="funcao-convite">Função</Label>
              <select
                id="funcao-convite"
                name="funcao_id"
                className="h-10 rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="">Sem função (não pode nada)</option>
                {funcoes.map((f) => (
                  <option key={f.id} value={f.id}>{f.nome}</option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <SubmitButton pendingLabel="Convidando…">Convidar</SubmitButton>
          </div>
        </form>
      )}
    </div>
  );
}

function LinhaAgente({ pessoa, funcoes }: { pessoa: PessoaDaTela; funcoes: FuncaoDaTela[] }) {
  const [estadoFuncao, acaoFuncao] = useActionState<EstadoEquipe, FormData>(definirFuncaoDoAgente, {});
  const [estadoLink, acaoLink] = useActionState<EstadoEquipe, FormData>(reenviarAcessoAgente, {});
  const [estadoRemover, acaoRemover] = useActionState<EstadoEquipe, FormData>(removerAgente, {});
  const [confirmando, setConfirmando] = useState(false);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0">
          <span className="font-medium">{pessoa.nome}</span>
          <span className="ml-2 text-sm text-muted-foreground">{pessoa.email}</span>
        </span>
        <div className="flex flex-wrap items-center gap-2">
          <form action={acaoFuncao} className="flex items-center gap-2">
            <input type="hidden" name="user_id" value={pessoa.id} />
            <select
              name="funcao_id"
              defaultValue={pessoa.funcaoId ?? ''}
              className="h-9 rounded-md border border-input bg-background px-2 text-sm"
              aria-label={`Função de ${pessoa.nome}`}
            >
              <option value="">Sem função</option>
              {funcoes.map((f) => (
                <option key={f.id} value={f.id}>{f.nome}</option>
              ))}
            </select>
            <SubmitButton variant="outline" size="sm" pendingLabel="…">Trocar</SubmitButton>
          </form>
          <form action={acaoLink}>
            <input type="hidden" name="user_id" value={pessoa.id} />
            <SubmitButton variant="outline" size="sm" pendingLabel="Gerando…">
              Gerar link de acesso
            </SubmitButton>
          </form>
          <Button type="button" variant="destructive" size="sm" onClick={() => setConfirmando(true)}>
            Remover
          </Button>
        </div>
      </div>

      <Aviso estado={estadoFuncao} />
      <Aviso estado={estadoLink} />
      <Aviso estado={estadoRemover} />

      {confirmando ? (
        <form action={acaoRemover} className="flex flex-wrap items-center gap-2 rounded-xl border border-destructive/40 bg-destructive/5 p-2">
          <input type="hidden" name="user_id" value={pessoa.id} />
          <span className="text-sm">
            Remover <b>{pessoa.email}</b>? O acesso é revogado na hora e, para voltar, é um convite
            novo.
          </span>
          <SubmitButton variant="destructive" size="sm" pendingLabel="Removendo…">
            Remover
          </SubmitButton>
          <Button type="button" variant="outline" size="sm" onClick={() => setConfirmando(false)}>
            Cancelar
          </Button>
        </form>
      ) : null}
    </div>
  );
}
