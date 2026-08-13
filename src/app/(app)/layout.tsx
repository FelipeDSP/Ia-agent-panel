import { Sidebar } from '@/components/sidebar';
import { exigirUsuario } from '@/lib/auth';
import { criarClienteServidor } from '@/lib/supabase/server';
import { toolsContratadas } from '@/lib/tools/contratacao';
import { menuDoPainel, type ItemMenuPainel } from '@/lib/tools/registro';

export default async function LayoutAplicacao({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  /*
   * O middleware ja barrou quem nao tem sessao, mas a checagem se repete aqui.
   * Middleware nao e fronteira de seguranca: nao roda em toda invocacao de
   * Server Action e o matcher pode ser contornado. A verificacao que vale e a
   * que fica junto do acesso ao dado.
   */
  const usuario = await exigirUsuario();

  // Nome do tenant so para exibir na sidebar. A query passa por RLS: o
  // tenant_admin so consegue ler o proprio tenant de qualquer forma.
  let nomeTenant: string | null = null;
  // Menu do painel montado AQUI, no servidor, a partir do registry e do que o
  // tenant contratou. Ver `menuDoPainel`: se a resolucao falhar, `contratadas`
  // vem vazio e sobram so as rotas sempre-visiveis — as condicionais somem.
  let itensPainel: ItemMenuPainel[] = [];

  if (usuario.tenantId) {
    const supabase = await criarClienteServidor();
    const { data } = await supabase
      .from('tenants')
      .select('nome')
      .eq('id', usuario.tenantId)
      .maybeSingle();

    nomeTenant = data?.nome ?? null;
    itensPainel = menuDoPainel(await toolsContratadas(usuario.tenantId));
  }

  return (
    <div className="flex min-h-screen">
      <Sidebar
        papel={usuario.papel}
        nome={usuario.nome}
        email={usuario.email}
        nomeTenant={nomeTenant}
        itensPainel={itensPainel}
      />
      {/*
        max-w limita a largura da leitura. Sem isso, em tela larga as tabelas e
        os cartoes esticam ate a borda e pares rotulo/valor ficam a meio metro
        de distancia um do outro.
      */}
      <main className="flex-1 overflow-x-hidden px-4 pb-8 pt-20 md:px-8 md:py-8">
        <div className="mx-auto w-full max-w-6xl">{children}</div>
      </main>
    </div>
  );
}
