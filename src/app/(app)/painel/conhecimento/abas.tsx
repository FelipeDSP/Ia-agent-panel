import Link from 'next/link';

/**
 * Abas da Base de conhecimento (30/09): "Chamou atendente" entrou como seção
 * daqui, não como item do menu — é o mesmo caso de Categorias dentro do
 * Catálogo. A rota fica declarada no registry com `menu: false`.
 */
export function AbasConhecimento({ atual }: { atual: 'base' | 'chamadas' }) {
  const abas = [
    { chave: 'base', href: '/painel/conhecimento', rotulo: 'Conteúdo' },
    { chave: 'chamadas', href: '/painel/conhecimento/chamadas', rotulo: 'Chamou atendente' },
  ] as const;
  return (
    <nav className="flex gap-1 border-b border-border" aria-label="Seções da base de conhecimento">
      {abas.map((a) => (
        <Link
          key={a.chave}
          href={a.href}
          aria-current={atual === a.chave ? 'page' : undefined}
          className={`-mb-px border-b-2 px-3 py-2 text-sm ${atual === a.chave ? 'border-primary font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
        >
          {a.rotulo}
        </Link>
      ))}
    </nav>
  );
}
