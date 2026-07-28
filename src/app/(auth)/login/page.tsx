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
    <Card>
      <CardHeader>
        <CardTitle>Painel de Agentes</CardTitle>
        <CardDescription>Entre com sua conta para continuar.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {mensagem ? <Alert variant="destructive">{mensagem}</Alert> : null}
        <FormularioLogin proximo={params.proximo ?? null} />
      </CardContent>
    </Card>
  );
}
