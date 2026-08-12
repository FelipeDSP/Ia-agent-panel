'use client';

import { ImagePlus, Loader2, Trash2 } from 'lucide-react';
import { useRef, useState, useTransition } from 'react';

import { Button } from '@/components/ui/button';
import { MIMES_ACEITOS, redimensionarImagem } from '@/lib/vendas/foto';

import { removerFotoProduto, salvarFotoProduto } from './acoes-foto';

/**
 * Foto de um produto: miniatura, trocar e remover.
 *
 * NÃO usa `<form action={...}>` como o resto da tela. O arquivo é
 * redimensionado no navegador ANTES de subir, e o que vai para a Server Action
 * é o Blob resultante, não o que o cliente escolheu — isso exige montar o
 * FormData na mão. É a única tela do painel que foge do padrão, e a razão é
 * essa.
 *
 * O erro fica no componente, não em `useActionState` global: cada produto tem
 * sua própria linha e um erro de upload pertence àquela linha, não à página.
 */
export function FotoProduto({
  produtoId,
  nome,
  fotoUrl,
}: {
  produtoId: string;
  nome: string;
  fotoUrl: string | null;
}) {
  const [pendente, iniciar] = useTransition();
  const [erro, setErro] = useState<string | null>(null);
  const [processando, setProcessando] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function aoEscolher(e: React.ChangeEvent<HTMLInputElement>) {
    const arquivo = e.target.files?.[0];
    // Limpa já: sem isso, escolher o MESMO arquivo depois de um erro não dispara
    // `change` de novo e o cliente acha que a tela travou.
    e.target.value = '';
    if (!arquivo) return;

    setErro(null);
    setProcessando(true);
    try {
      const { blob } = await redimensionarImagem(arquivo);
      const fd = new FormData();
      fd.set('produto_id', produtoId);
      // Nome fixo: o servidor decide o path a partir do produto_id, e o nome que
      // veio do celular não interessa — pode até carregar dado do aparelho.
      fd.set('foto', new File([blob], 'foto.jpg', { type: 'image/jpeg' }));

      iniciar(async () => {
        const r = await salvarFotoProduto({}, fd);
        if (r.erro) setErro(r.erro);
      });
    } catch (err) {
      setErro(err instanceof Error ? err.message : 'Não foi possível processar a imagem.');
    } finally {
      setProcessando(false);
    }
  }

  function aoRemover() {
    setErro(null);
    const fd = new FormData();
    fd.set('produto_id', produtoId);
    iniciar(async () => {
      const r = await removerFotoProduto({}, fd);
      if (r.erro) setErro(r.erro);
    });
  }

  const ocupado = pendente || processando;

  return (
    <div className="flex flex-col items-start gap-1">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={ocupado}
          aria-label={fotoUrl ? `Trocar foto de ${nome}` : `Adicionar foto a ${nome}`}
          className="relative h-12 w-12 shrink-0 overflow-hidden rounded-md border border-border bg-muted/40 transition hover:border-primary disabled:opacity-50"
        >
          {ocupado ? (
            <Loader2 className="absolute inset-0 m-auto h-4 w-4 animate-spin text-muted-foreground" />
          ) : fotoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- URL assinada
            // de vida curta: o otimizador do Next armazenaria em cache uma URL
            // que expira, e a miniatura quebraria depois de alguns minutos.
            <img src={fotoUrl} alt={`Foto de ${nome}`} className="h-full w-full object-cover" />
          ) : (
            <ImagePlus className="absolute inset-0 m-auto h-4 w-4 text-muted-foreground" />
          )}
        </button>

        {fotoUrl && !ocupado ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={aoRemover}
            aria-label={`Remover foto de ${nome}`}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        ) : null}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept={MIMES_ACEITOS.join(',')}
        className="hidden"
        onChange={aoEscolher}
      />

      {erro ? <p className="max-w-[12rem] text-xs text-destructive">{erro}</p> : null}
    </div>
  );
}
