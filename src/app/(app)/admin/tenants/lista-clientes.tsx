'use client';

import { Search } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';

import { EntrarNaConta } from '@/components/entrar-na-conta';
import { Badge } from '@/components/ui/badge';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { filtrarPanorama, type LinhaPanorama } from '@/lib/tenants/panorama';
import { DIAS_RECENTE } from '@/lib/tenants/panorama';

/**
 * A lista de clientes.
 *
 * A BUSCA É NO NAVEGADOR, de propósito: são onze clientes e a lista inteira já
 * está na página. Filtrar no servidor custaria uma ida e volta por tecla para
 * esconder linhas que já chegaram — e a busca que responde enquanto se digita
 * é a diferença entre procurar e lembrar o nome exato.
 *
 * Quando a lista passar de algumas centenas isto vira paginação no servidor; o
 * sinal será a página demorar a abrir, não a busca ficar lenta.
 */

const COR: Record<string, string> = {
  erro: 'destructive',
  alerta: 'warning',
  ok: 'success',
  neutro: 'secondary',
};

export function ListaClientes({ linhas }: { linhas: LinhaPanorama[] }) {
  const [termo, setTermo] = useState('');
  const visiveis = useMemo(() => filtrarPanorama(linhas, termo), [linhas, termo]);

  return (
    <div className="flex flex-col gap-3">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <input
          type="search"
          value={termo}
          onChange={(e) => setTermo(e.target.value)}
          placeholder="Buscar por nome ou slug"
          aria-label="Buscar cliente"
          className="w-full rounded-md border border-input bg-background py-2 pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring sm:max-w-xs"
        />
      </div>

      <div className="rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Cliente</TableHead>
              <TableHead>Situação</TableHead>
              <TableHead className="text-right">Conversas ({DIAS_RECENTE}d)</TableHead>
              <TableHead className="text-right">Falhas</TableHead>
              <TableHead className="text-right">Custo do mês</TableHead>
              <TableHead>Última conversa</TableHead>
              <TableHead>Chatwoot</TableHead>
              <TableHead className="text-right">Conta</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visiveis.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="py-10 text-center text-muted-foreground">
                  {termo ? `Nenhum cliente com "${termo}".` : 'Nenhum cliente cadastrado.'}
                </TableCell>
              </TableRow>
            ) : (
              visiveis.map((l) => (
                <TableRow key={l.id}>
                  <TableCell>
                    <Link
                      href={`/admin/tenants/${l.id}`}
                      className="font-medium underline-offset-4 hover:underline"
                    >
                      {l.nome}
                    </Link>
                    <div className="text-xs text-muted-foreground">{l.slug}</div>
                  </TableCell>

                  <TableCell>
                    {/* O `title` leva o que fazer a respeito: o rótulo diz o
                        quê, e quem para o mouse quer saber o porquê. */}
                    <Badge variant={(COR[l.situacao.gravidade] ?? 'secondary') as 'default'} title={l.situacao.detalhe}>
                      {l.situacao.rotulo}
                    </Badge>
                  </TableCell>

                  <TableCell className="text-right tabular-nums">
                    {l.conversas7d > 0 ? l.conversas7d : <span className="text-muted-foreground">—</span>}
                  </TableCell>

                  <TableCell className="text-right tabular-nums">
                    {/* Zero falhas é o normal e não merece tinta; qualquer
                        falha merece, porque é cliente sem resposta. */}
                    {l.falhas7d > 0
                      ? <span className="font-medium text-destructive">{l.falhas7d}</span>
                      : <span className="text-muted-foreground">0</span>}
                  </TableCell>

                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {l.custoMesTexto}
                  </TableCell>

                  <TableCell className="text-muted-foreground">{l.ultimaAtividadeTexto}</TableCell>

                  <TableCell className="text-muted-foreground">
                    {l.chatwootAccountId ? (
                      <span className="tabular-nums text-xs">
                        {l.chatwootAccountId}
                        {' / caixa '}
                        {l.chatwootInboxId}
                      </span>
                    ) : (
                      <span className="text-xs">—</span>
                    )}
                  </TableCell>

                  <TableCell className="text-right">
                    <EntrarNaConta tenantId={l.id} />
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
