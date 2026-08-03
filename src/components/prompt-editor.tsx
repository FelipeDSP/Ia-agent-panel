'use client';

import { useActionState, useState, useTransition } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { SubmitButton } from '@/components/ui/submit-button';
import { Textarea } from '@/components/ui/textarea';
import { formatarDataHora } from '@/lib/utils';
import { DICAS_PROMPT, MODELO_PROMPT } from '@/lib/orientacao';
import {
  restaurarVersaoPrompt,
  salvarPrompt,
  type EstadoPrompt,
} from '@/lib/tenants/prompt-acoes';

export type VersaoPrompt = {
  id: string;
  conteudo: string;
  criado_em: string;
  autor: string | null;
};

export function PromptEditor({
  tenantId,
  promptAtual,
  versoes,
}: {
  tenantId: string;
  promptAtual: string;
  versoes: VersaoPrompt[];
}) {
  // bind do tenantId na Server Action (fecha o id no servidor, não vem do form)
  const salvar = salvarPrompt.bind(null, tenantId);
  const [estado, acao] = useActionState<EstadoPrompt, FormData>(salvar, {});

  const [valor, setValor] = useState(promptAtual);
  const [mostrarHistorico, setMostrarHistorico] = useState(false);
  const [pendente, iniciar] = useTransition();
  const [msgRollback, setMsgRollback] = useState<string | null>(null);
  // "Usar modelo": preenche o esqueleto. Se já houver texto, pede confirmação
  // antes de substituir, para não apagar o que o admin escreveu sem querer.
  const [confirmarModelo, setConfirmarModelo] = useState(false);

  function usarModelo() {
    if (valor.trim() && !confirmarModelo) {
      setConfirmarModelo(true);
      return;
    }
    setValor(MODELO_PROMPT);
    setConfirmarModelo(false);
  }

  function restaurar(versaoId: string) {
    setMsgRollback(null);
    iniciar(async () => {
      const r = await restaurarVersaoPrompt(tenantId, versaoId);
      if (r.erro) setMsgRollback(r.erro);
      else {
        const v = versoes.find((x) => x.id === versaoId);
        if (v) setValor(v.conteudo);
        setMsgRollback(r.sucesso ?? 'Restaurado.');
      }
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <details className="rounded-md border border-border bg-muted/40 px-4 py-3 text-sm">
        <summary className="cursor-pointer font-medium">Como escrever um bom prompt</summary>
        <ul className="mt-3 flex list-disc flex-col gap-1.5 pl-5 text-muted-foreground">
          {DICAS_PROMPT.map((dica) => (
            <li key={dica}>{dica}</li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-muted-foreground">
          Sem saber por onde começar? Use <span className="font-medium">&ldquo;Usar modelo&rdquo;</span>{' '}
          para preencher um esqueleto e depois é só editar.
        </p>
      </details>

      <form action={acao} className="flex flex-col gap-3">
        <Textarea
          name="system_prompt"
          value={valor}
          onChange={(e) => setValor(e.target.value)}
          rows={12}
          className="font-mono text-sm leading-relaxed"
        />

        {estado.erro ? <Alert variant="destructive">{estado.erro}</Alert> : null}
        {estado.sucesso ? <Alert variant="success">{estado.sucesso}</Alert> : null}

        {confirmarModelo ? (
          <Alert>
            <div className="flex flex-col gap-2">
              <span>Isto substitui o texto atual pelo modelo. Quer continuar?</span>
              <div className="flex gap-2">
                <Button type="button" size="sm" onClick={usarModelo}>
                  Substituir pelo modelo
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setConfirmarModelo(false)}
                >
                  Cancelar
                </Button>
              </div>
            </div>
          </Alert>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          <SubmitButton>Salvar prompt</SubmitButton>
          <Button type="button" variant="outline" onClick={usarModelo}>
            Usar modelo
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => setMostrarHistorico((v) => !v)}
          >
            {mostrarHistorico ? 'Ocultar histórico' : `Histórico (${versoes.length})`}
          </Button>
        </div>
      </form>

      {mostrarHistorico ? (
        <div className="flex flex-col gap-3 rounded-md border border-border p-4">
          {msgRollback ? <Alert>{msgRollback}</Alert> : null}

          {versoes.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nenhuma versão anterior ainda. O histórico começa a partir da primeira
              alteração.
            </p>
          ) : (
            <ul className="flex flex-col gap-3">
              {versoes.map((v) => (
                <li
                  key={v.id}
                  className="flex flex-col gap-2 border-b border-border pb-3 last:border-0 last:pb-0"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs text-muted-foreground">
                      Substituído em {formatarDataHora(v.criado_em)}
                      {v.autor ? ` · ${v.autor}` : ''}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={pendente}
                      onClick={() => restaurar(v.id)}
                    >
                      Restaurar
                    </Button>
                  </div>
                  <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs">
                    {v.conteudo}
                  </pre>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
