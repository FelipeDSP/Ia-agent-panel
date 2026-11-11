import Link from 'next/link';

import { Alert } from '@/components/ui/alert';
import { buttonVariants } from '@/components/ui/button';
import { exigirSuperAdmin } from '@/lib/auth';
import { criarClienteServidor } from '@/lib/supabase/server';
import { ordenarPanorama, DIAS_RECENTE } from '@/lib/tenants/panorama';
import { montarPanorama } from '@/lib/tenants/panorama.server';

import { ListaClientes } from './lista-clientes';

/**
 * A lista de clientes da agência.
 *
 * ELA RESPONDE "COMO AS CONTAS ESTÃO", e antes não respondia. Mostrava
 * documentos e conversas ACUMULADOS desde sempre (669 contra 2) e um selo
 * "ativo" repetido em onze linhas iguais — com isso, um cliente conectado e
 * parado há um mês era indistinguível de um que atendeu hoje de manhã. Em
 * 19/10 o Felipe pediu esse retrato e ele saiu de SQL escrito à mão, porque a
 * tela não tinha.
 *
 * O inventário ("o que esta conta tem") continua na ficha do cliente. Aqui vai
 * o que muda sozinho e precisa de olho: atividade da semana, falhas, custo do
 * mês e quando foi a última conversa.
 */
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
    .select('id, slug, nome, ativo, agente_ativo, chatwoot_account_id, chatwoot_inbox_id, criado_em')
    .is('deletado_em', null)
    .order('nome');

  if (error) {
    return (
      <Alert variant="destructive">Não foi possível carregar os clientes: {error.message}</Alert>
    );
  }

  const { linhas, erros } = await montarPanorama(supabase, tenants ?? []);
  const ordenadas = ordenarPanorama(linhas);

  // Os números do topo saem das MESMAS linhas da tabela: um resumo que não
  // fecha com a lista abaixo dele é pior que resumo nenhum.
  const atendendo = ordenadas.filter((l) => l.situacao.chave === 'ativo').length;
  const pedemAtencao = ordenadas.filter((l) => l.situacao.gravidade === 'erro' || l.situacao.gravidade === 'alerta').length;
  const conversas = ordenadas.reduce((n, l) => n + l.conversas7d, 0);
  const falhas = ordenadas.reduce((n, l) => n + l.falhas7d, 0);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Clientes</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {ordenadas.length} {ordenadas.length === 1 ? 'cliente' : 'clientes'} · {atendendo} atendendo
            {pedemAtencao > 0 ? ` · ${pedemAtencao} ${pedemAtencao === 1 ? 'pede' : 'pedem'} atenção` : ''}
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

      {/* Falha de leitura vira aviso, não tela vazia: a lista continua útil
          sem o custo, e esconder que faltou dado é o que faz alguém confiar
          num número que não existe. */}
      {erros.length > 0 ? (
        <Alert>Parte dos números não carregou ({erros.join('; ')}). A lista abaixo está completa.</Alert>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-3">
        <Resumo rotulo={`Conversas (${DIAS_RECENTE} dias)`} valor={conversas} />
        <Resumo rotulo={`Falhas (${DIAS_RECENTE} dias)`} valor={falhas} alerta={falhas > 0} />
        <Resumo rotulo="Precisam de atenção" valor={pedemAtencao} alerta={pedemAtencao > 0} />
      </div>

      <ListaClientes linhas={ordenadas} />
    </div>
  );
}

function Resumo({ rotulo, valor, alerta = false }: { rotulo: string; valor: number; alerta?: boolean }) {
  return (
    <div className="rounded-lg border border-border p-4">
      <p className="text-sm text-muted-foreground">{rotulo}</p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${alerta ? 'text-destructive' : ''}`}>{valor}</p>
    </div>
  );
}
