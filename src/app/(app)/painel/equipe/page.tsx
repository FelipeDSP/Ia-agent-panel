import { Ajuda } from '@/components/ui/ajuda';
import { Alert } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { exigirTenantAdmin } from '@/lib/auth';
import { criarClienteServidor } from '@/lib/supabase/server';

import { Equipe, Funcoes, type FuncaoDaTela, type PessoaDaTela } from './componentes';

/**
 * A equipe da conta — quem o CLIENTE põe para trabalhar no painel dele.
 *
 * Admin-only por três caminhos que não se substituem: o menu não mostra
 * (`somenteAdmin` no registry), esta página recusa (`exigirTenantAdmin`), e
 * cada Server Action recusa por conta própria. Abaixo das três está a RLS.
 */
export default async function PaginaEquipe() {
  const usuario = await exigirTenantAdmin();
  const supabase = await criarClienteServidor();

  // `max_agentes` em consulta própria: ele nasce na migração 81 e o painel é
  // deploy independente do banco. Junto, um painel novo contra um banco velho
  // derrubaria a tela inteira em vez de dizer o que falta.
  const [{ data: tenant, error: erroTeto }, { data: funcoesRaw }, { data: pessoasRaw }] = await Promise.all([
    supabase.from('tenants').select('max_agentes').eq('id', usuario.tenantId).maybeSingle(),
    supabase
      .from('tenant_funcoes')
      .select('id, nome, capacidades')
      .eq('tenant_id', usuario.tenantId)
      .order('nome'),
    supabase
      .from('usuarios_painel')
      .select('id, nome, email, papel, ativo, funcao_id')
      .eq('tenant_id', usuario.tenantId)
      .order('papel')
      .order('nome'),
  ]);

  if (erroTeto) {
    return (
      <Alert variant="warning">
        A equipe por conta ainda não está disponível neste ambiente (migração 81 não aplicada).
      </Alert>
    );
  }

  const maxAgentes = Number(tenant?.max_agentes ?? 0);
  const funcoes: FuncaoDaTela[] = (funcoesRaw ?? []).map((f) => ({
    id: f.id,
    nome: f.nome,
    capacidades: (f.capacidades as string[] | null) ?? [],
  }));
  const pessoas: PessoaDaTela[] = (pessoasRaw ?? []).map((p) => ({
    id: p.id,
    nome: p.nome,
    email: p.email,
    papel: p.papel,
    ativo: p.ativo !== false,
    funcaoId: p.funcao_id ?? null,
  }));
  const agentes = pessoas.filter((p) => p.papel === 'tenant_agente');
  const emUso = agentes.filter((p) => p.ativo).length;

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Equipe</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Quem da sua empresa usa o painel, e o que cada um pode fazer.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-1.5">
            Funções
            <Ajuda titulo="Funções">
              Uma <strong>função</strong> é um conjunto de permissões com nome — &quot;Vendedor&quot;,
              &quot;Suporte&quot;. Você marca o que ela pode fazer e depois dá essa função às pessoas.
              <br />
              <br />
              Mudar a função muda <strong>todo mundo que a tem</strong>, de uma vez, e vale na hora:
              quem estiver com a tela aberta já não consegue fazer o que você tirou.
              <br />
              <br />
              Você, como administrador, pode tudo e não tem função.
            </Ajuda>
          </CardTitle>
          <CardDescription>
            {funcoes.length > 0
              ? `${funcoes.length} função(ões) criada(s).`
              : 'Nenhuma função ainda. Crie uma antes de convidar alguém.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Funcoes funcoes={funcoes} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-1.5">
            Pessoas
            <Ajuda titulo="Pessoas">
              <strong>Senha ninguém digita por ninguém</strong> — nem você. O convite gera um link, e a
              pessoa escolhe a senha dela. &quot;Gerar link de acesso&quot; serve também para quem
              esqueceu ou perdeu o link.
              <br />
              <br />
              <strong>Remover</strong> revoga o acesso na hora e é definitivo: para voltar, é um
              convite novo.
              <br />
              <br />O número de acessos é contratado com a agência.
            </Ajuda>
          </CardTitle>
          <CardDescription>
            {maxAgentes === 0
              ? 'Sua conta não tem acessos de equipe contratados. Fale com a agência para liberar.'
              : `${emUso} de ${maxAgentes} acesso(s) em uso.`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Equipe
            admins={pessoas.filter((p) => p.papel === 'tenant_admin')}
            agentes={agentes}
            funcoes={funcoes}
            lotado={maxAgentes === 0 || emUso >= maxAgentes}
            semAcessos={maxAgentes === 0}
            euId={usuario.id}
          />
        </CardContent>
      </Card>
    </div>
  );
}
