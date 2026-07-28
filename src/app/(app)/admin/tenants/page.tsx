import Link from 'next/link';

import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
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
import { formatarDataHora } from '@/lib/utils';

type LinhaTenant = {
  id: string;
  slug: string;
  nome: string;
  ativo: boolean;
  agente_ativo: boolean;
  chatwoot_account_id: number | null;
  criado_em: string;
};

export default async function PaginaTenants() {
  await exigirSuperAdmin();

  const supabase = await criarClienteServidor();

  /*
   * Sem filtro de tenant na query: a policy de tenants ja devolve tudo para
   * super_admin e nada de terceiros para os demais. Se um tenant_admin
   * chegasse aqui apesar do exigirSuperAdmin acima, veria uma linha so — a
   * dele. Duas camadas, como o CLAUDE.md pede.
   */
  const { data: tenants, error } = await supabase
    .from('tenants')
    .select('id, slug, nome, ativo, agente_ativo, chatwoot_account_id, criado_em')
    .is('deletado_em', null)
    .order('nome');

  if (error) {
    return (
      <div className="text-sm text-destructive">
        Não foi possível carregar os clientes: {error.message}
      </div>
    );
  }

  const lista = (tenants ?? []) as LinhaTenant[];

  /*
   * Contagens por tenant.
   *
   * `head: true` com `count` traz so o numero, sem as linhas — carregar 12 mil
   * chunks para exibir "12" seria caro a toa. Uma chamada por tenant e
   * aceitavel com poucos clientes; quando passar de algumas dezenas, vira uma
   * view materializada ou uma RPC agregando de uma vez.
   */
  const metricas = await Promise.all(
    lista.map(async (tenant) => {
      const [documentos, conversas] = await Promise.all([
        supabase
          .from('kb_documentos')
          .select('id', { count: 'exact', head: true })
          .eq('tenant_id', tenant.id)
          .is('deletado_em', null),
        supabase
          .from('conversas')
          .select('id', { count: 'exact', head: true })
          .eq('tenant_id', tenant.id),
      ]);

      return {
        id: tenant.id,
        documentos: documentos.count ?? 0,
        conversas: conversas.count ?? 0,
      };
    }),
  );

  const porId = new Map(metricas.map((m) => [m.id, m]));

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Clientes</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {lista.length} {lista.length === 1 ? 'cliente cadastrado' : 'clientes cadastrados'}
          </p>
        </div>
        {/*
          Link estilizado como botão em vez de <Link><Button>: um <button>
          dentro de <a> é aninhamento inválido e o React 19 lança erro de
          hidratação em produção (em dev só avisa).
        */}
        <Link href="/admin/tenants/novo" className={buttonVariants()}>
          Novo cliente
        </Link>
      </header>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Cliente</TableHead>
                <TableHead>Chatwoot</TableHead>
                <TableHead className="text-right">Documentos</TableHead>
                <TableHead className="text-right">Conversas</TableHead>
                <TableHead>Situação</TableHead>
                <TableHead>Criado em</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {lista.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="py-10 text-center text-muted-foreground">
                    Nenhum cliente cadastrado.
                  </TableCell>
                </TableRow>
              ) : (
                lista.map((tenant) => {
                  const m = porId.get(tenant.id);
                  return (
                    <TableRow key={tenant.id}>
                      <TableCell>
                        <Link
                          href={`/admin/tenants/${tenant.id}`}
                          className="font-medium underline-offset-4 hover:underline"
                        >
                          {tenant.nome}
                        </Link>
                        <div className="text-xs text-muted-foreground">{tenant.slug}</div>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {tenant.chatwoot_account_id ?? (
                          <span className="text-xs">não conectado</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {m?.documentos ?? 0}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {m?.conversas ?? 0}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1.5">
                          <Badge variant={tenant.ativo ? 'success' : 'secondary'}>
                            {tenant.ativo ? 'ativo' : 'suspenso'}
                          </Badge>
                          {tenant.ativo && !tenant.agente_ativo ? (
                            <Badge variant="warning">agente desligado</Badge>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {formatarDataHora(tenant.criado_em)}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

    </div>
  );
}
