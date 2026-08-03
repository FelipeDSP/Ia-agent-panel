import { Alert } from '@/components/ui/alert';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

import { FormularioLogin } from './formulario';

const MENSAGENS_ERRO: Record<string, string> = {
  link_invalido: 'Link inválido. Peça a recuperação de novo.',
  link_expirado: 'Link expirado. Peça a recuperação de novo.',
};

export default async function PaginaLogin({
  searchParams,
}: {
  searchParams: Promise<{ proximo?: string; erro?: string }>;
}) {
  const params = await searchParams;
  const mensagem = params.erro ? MENSAGENS_ERRO[params.erro] : undefined;

  return (
    <div className="flex flex-col items-center gap-6">
      <span className="flex items-center gap-2">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/chatyou-logo.png" alt="chatyou" className="marca-clara h-8 w-auto" />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/chatyou-logo-branca.png" alt="chatyou" className="marca-escura h-8 w-auto" />
        <span className="text-sm font-semibold text-muted-foreground">· IA</span>
      </span>

      <Card className="w-full">
        <CardHeader>
          <CardTitle>Entrar</CardTitle>
          <CardDescription>Acesse o painel de agentes de IA.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {mensagem ? <Alert variant="destructive">{mensagem}</Alert> : null}
          <FormularioLogin proximo={params.proximo ?? null} />
        </CardContent>
      </Card>
    </div>
  );
}
