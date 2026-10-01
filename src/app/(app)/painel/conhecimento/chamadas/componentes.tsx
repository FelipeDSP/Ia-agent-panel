'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useState } from 'react';

import { ingerirTexto, type EstadoIngestao } from '../acoes';
import { rascunhoDeEntrada, tituloSugerido, type Chamada } from '@/lib/conhecimento/lacunas';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SubmitButton } from '@/components/ui/submit-button';

const quando = (iso: string) =>
  new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

export function ListaChamadas({ chamadas }: { chamadas: Chamada[] }) {
  const router = useRouter();
  const [aberta, setAberta] = useState<string | null>(null);
  const [estado, acao] = useActionState<EstadoIngestao, FormData>(ingerirTexto, {});

  useEffect(() => {
    if (estado.sucesso) {
      setAberta(null);
      router.refresh();
    }
  }, [estado, router]);

  if (chamadas.length === 0) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          O agente não chamou atendente nos últimos 60 dias. Quando chamar, a conversa aparece
          aqui com o resumo do que o cliente queria.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {estado.sucesso ? <Alert variant="success">{estado.sucesso}</Alert> : null}

      <p className="text-sm text-muted-foreground">
        {chamadas.length} chamada{chamadas.length > 1 ? 's' : ''} nos últimos 60 dias. Nem toda
        uma é falta de conteúdo — o cliente pode ter pedido para falar com uma pessoa. Use as que
        forem dúvida para escrever na base: a próxima o agente responde sozinho.
      </p>

      {chamadas.map((c) => {
        const chave = `${c.quando}:${c.conversationId ?? '-'}`;
        return (
          <Card key={chave}>
            <CardContent className="flex flex-col gap-3 py-4">
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span className="tabular-nums">{quando(c.quando)}</span>
                {c.conversationId !== null ? (
                  <Link
                    href={`/painel/conversas/${c.conversationId}`}
                    className="text-primary underline-offset-4 hover:underline"
                  >
                    ver a conversa
                  </Link>
                ) : null}
                <Badge variant={c.desfecho === 'transferiu' ? 'secondary' : 'warning'}>
                  {c.desfecho === 'transferiu' ? 'atendente chamado' : 'fora do horário — ninguém assumiu'}
                </Badge>
              </div>

              <p className="text-sm">{c.resumo}</p>

              {aberta === chave ? (
                <form action={acao} className="flex flex-col gap-3 rounded-md border border-border bg-muted/40 p-3">
                  {estado.erro ? <Alert variant="destructive">{estado.erro}</Alert> : null}
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor={`titulo-${chave}`}>Título</Label>
                    <Input id={`titulo-${chave}`} name="titulo" defaultValue={tituloSugerido(c.resumo)} maxLength={120} required />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor={`texto-${chave}`}>Conteúdo</Label>
                    {/*
                      O rascunho traz a PERGUNTA e deixa a resposta em branco, de
                      propósito: um texto que chuta a resposta entraria na base com
                      cara de verdade e seria dito a todos os clientes.
                    */}
                    <textarea
                      id={`texto-${chave}`}
                      name="texto"
                      defaultValue={rascunhoDeEntrada(c.resumo)}
                      rows={6}
                      required
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    />
                    <p className="text-xs text-muted-foreground">
                      Escreva a resposta como você a daria ao cliente. Preço e prazo de produto
                      ficam no catálogo, não aqui.
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <SubmitButton>Adicionar à base</SubmitButton>
                    <Button type="button" variant="outline" onClick={() => setAberta(null)}>
                      Cancelar
                    </Button>
                  </div>
                </form>
              ) : (
                <div>
                  <Button type="button" variant="outline" size="sm" onClick={() => setAberta(chave)}>
                    Virar entrada da base
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

/** Uma linha de `kb_aprendizado`, como `painel_aprendizado_recente` a devolve. */
export interface Aprendido {
  id: string;
  conversation_id: number | string;
  pergunta: string;
  resposta: string;
  status: 'publicado' | 'descartado' | 'erro';
  motivo: string | null;
  origem: string | null;
  criado_em: string;
}

const PORQUE: Record<string, string> = {
  dado_pessoal: 'tinha dado pessoal do cliente',
  caso_particular: 'valia só para aquele cliente',
  nao_resposta: 'não era uma resposta ("vou verificar", "bom dia")',
  curta: 'curta demais para informar',
  longa: 'longa demais para uma entrada de base',
  sem_pergunta: 'sem a pergunta correspondente',
};

/**
 * O que o aprendizado automático guardou e o que recusou.
 *
 * O descartado aparece de propósito: é ele que explica por que a base não
 * cresceu depois de uma semana de atendimento, e é o único jeito de o cliente
 * perceber que o filtro está recusando algo que ele queria lá.
 */
export function ListaAprendido({ itens }: { itens: Aprendido[] }) {
  if (itens.length === 0) return null;
  const publicados = itens.filter((i) => i.status === 'publicado').length;

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 py-4">
        <div>
          <p className="font-medium">Aprendido com a sua equipe</p>
          <p className="text-sm text-muted-foreground">
            {publicados} de {itens.length} respostas viraram conteúdo da base. Elas estão na aba
            Conteúdo e podem ser editadas ou removidas.
          </p>
        </div>
        <ul className="flex flex-col gap-2 text-sm">
          {itens.map((i) => (
            <li key={i.id} className="flex flex-wrap items-baseline gap-2 border-t border-border pt-2">
              <Badge variant={i.status === 'publicado' ? 'success' : i.status === 'erro' ? 'danger' : 'secondary'}>
                {i.status === 'publicado' ? 'na base' : i.status === 'erro' ? 'falhou' : 'não guardado'}
              </Badge>
              <span className="min-w-0 flex-1">{i.pergunta}</span>
              {i.status === 'descartado' && i.motivo ? (
                <span className="text-xs text-muted-foreground">{PORQUE[i.motivo] ?? i.motivo}</span>
              ) : null}
              <Link
                href={`/painel/conversas/${i.conversation_id}`}
                className="text-xs text-primary underline-offset-4 hover:underline"
              >
                conversa
              </Link>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
