'use client';

import Link from 'next/link';
import { Pencil, Plus, Trash2, X } from 'lucide-react';
import { useActionState, useState, useTransition } from 'react';

import {
  criarCategoria,
  removerCategoria,
  renomearCategoria,
  type EstadoCategoria,
} from '../acoes-categoria';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SubmitButton } from '@/components/ui/submit-button';

export type CategoriaComUso = { id: string; nome: string; produtos: number };

export function GestaoCategorias({
  categoriasIniciais,
}: {
  categoriasIniciais: CategoriaComUso[];
}) {
  const [editando, setEditando] = useState<CategoriaComUso | null>(null);
  const [erroRemocao, setErroRemocao] = useState<string | null>(null);
  const [removendoId, setRemovendoId] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const [estadoCriar, acaoCriar] = useActionState<EstadoCategoria, FormData>(criarCategoria, {});
  const [estadoRenomear, acaoRenomear] = useActionState<EstadoCategoria, FormData>(
    renomearCategoria,
    {},
  );

  const estadoForm = editando ? estadoRenomear : estadoCriar;

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>{editando ? `Renomear "${editando.nome}"` : 'Nova categoria'}</CardTitle>
          <CardDescription>
            {editando
              ? 'O nome muda em todos os produtos que já usam esta categoria.'
              : 'Comece pelo que o cliente perguntaria: "vocês têm queijo?" costuma ser uma categoria.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {/*
            `key` remonta o formulário ao trocar entre criar e renomear — é a
            remontagem que reaplica o `defaultValue`. Sem isso, clicar em
            renomear deixaria o campo com o texto anterior.
          */}
          <form
            key={editando?.id ?? 'nova'}
            action={editando ? acaoRenomear : acaoCriar}
            className="flex flex-wrap items-end gap-3"
          >
            {editando ? <input type="hidden" name="id" value={editando.id} /> : null}
            <div className="flex min-w-56 flex-1 flex-col gap-2">
              <Label htmlFor="nome">Nome</Label>
              <Input
                id="nome"
                name="nome"
                defaultValue={editando?.nome ?? ''}
                placeholder="Queijos"
                maxLength={60}
                required
              />
            </div>
            <SubmitButton>
              {editando ? 'Salvar' : (
                <>
                  <Plus className="mr-1 h-4 w-4" /> Criar
                </>
              )}
            </SubmitButton>
            {editando ? (
              <Button type="button" variant="ghost" onClick={() => setEditando(null)}>
                <X className="mr-1 h-4 w-4" /> Cancelar
              </Button>
            ) : null}
          </form>

          {estadoForm.erro ? (
            <Alert variant="destructive" className="mt-3">
              {estadoForm.erro}
            </Alert>
          ) : null}
          {estadoForm.sucesso ? (
            <Alert className="mt-3">{estadoForm.sucesso}</Alert>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Suas categorias</CardTitle>
          <CardDescription>
            Remover só é possível quando a categoria não tem nenhum produto — mova-os
            antes, no{' '}
            <Link className="underline" href="/painel/catalogo">
              catálogo
            </Link>
            .
          </CardDescription>
        </CardHeader>
        <CardContent>
          {erroRemocao ? (
            <Alert variant="destructive" className="mb-3">
              {erroRemocao}
            </Alert>
          ) : null}

          {categoriasIniciais.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nenhuma categoria ainda. Crie a primeira acima.
            </p>
          ) : (
            <ul className="divide-y">
              {categoriasIniciais.map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-3 py-3">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{c.nome}</span>
                    <Badge variant="secondary">
                      {c.produtos === 1 ? '1 produto' : `${c.produtos} produtos`}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setErroRemocao(null);
                        setEditando(c);
                      }}
                    >
                      <Pencil className="h-4 w-4" />
                      <span className="sr-only">Renomear {c.nome}</span>
                    </Button>
                    {/*
                      O botão fica DESABILITADO quando há produtos, mas a Server
                      Action recusa de qualquer jeito e o `on delete restrict` da
                      FK recusa por baixo dela. Três camadas, e a de cima é só
                      cortesia: desabilitar não impede uma chamada direta.
                    */}
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={c.produtos > 0 || removendoId === c.id}
                      title={
                        c.produtos > 0
                          ? 'Mova os produtos para outra categoria antes de remover'
                          : undefined
                      }
                      onClick={() => {
                        setErroRemocao(null);
                        setRemovendoId(c.id);
                        startTransition(async () => {
                          const r = await removerCategoria(c.id);
                          setRemovendoId(null);
                          if (r.erro) setErroRemocao(r.erro);
                        });
                      }}
                    >
                      <Trash2 className="h-4 w-4" />
                      <span className="sr-only">Remover {c.nome}</span>
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
