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
