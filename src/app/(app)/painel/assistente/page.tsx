import { AlertTriangle, CircleAlert, Info } from 'lucide-react';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { exigirTenantAdmin } from '@/lib/auth';
import { criarClienteServidor } from '@/lib/supabase/server';
import { detectar, ordenar, type Gravidade } from '@/lib/assistente/deteccoes';
import { montarRetrato } from '@/lib/assistente/snapshot';

import { Conversa } from './conversa';

/**
 * O ASSISTENTE DE CONFIGURAÇÃO (parte 3: a tela).
 *
 * DUAS METADES, e a ordem na tela é deliberada:
 *
 *   1. O QUE O PAINEL JÁ SABE, de graça. Os achados mecânicos (`detectar`)
 *      aparecem assim que a página abre, sem perguntar nada a modelo nenhum.
 *      Num dia só, lendo a configuração de três clientes à mão, apareceram oito
 *      defeitos e nenhum deles precisava de inteligência — precisava de alguém
 *      olhando. Essa parte é instantânea e não custa um centavo;
 *   2. A CONVERSA, para o que é semântico ("este prompt manda rotear mas a
 *      conta vende"). Essa custa, e o custo é da agência.
 *
 * `somenteAdmin` no registry e `exigirTenantAdmin()` aqui: o assistente mexe em
 * prompt e horário, que são decisão de quem é dono da conta. Um atendente da
 * equipe não reconfigura o agente que ele usa.
 *
 * Esta página NÃO é superfície de tool: o assistente existe para toda conta, e
 * não há módulo "assistente" para contratar. Por isso a rota mora em
 * `ROTAS_SEMPRE_VISIVEIS` — e `npm run teste:superficie` reprovaria se ela não
 * estivesse em lugar nenhum.
 */

const ICONE: Record<Gravidade, typeof CircleAlert> = {
  erro: CircleAlert,
  aviso: AlertTriangle,
  nota: Info,
};

const COR: Record<Gravidade, string> = {
  erro: 'text-destructive',
  aviso: 'text-amber-600 dark:text-amber-500',
  nota: 'text-muted-foreground',
};

export default async function PaginaAssistente() {
  const usuario = await exigirTenantAdmin();
  const supabase = await criarClienteServidor();
  const retrato = await montarRetrato(supabase, usuario.tenantId);
  const achados = ordenar(detectar(retrato));

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Assistente</h1>
        <p className="text-sm text-muted-foreground">
          Ele olha a configuração da sua conta, explica o que está atrapalhando o atendimento
          e propõe a correção. Nada muda sem você aprovar.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {achados.length === 0
              ? 'Nenhuma incoerência encontrada'
              : `${achados.length} ${achados.length === 1 ? 'ponto de atenção' : 'pontos de atenção'}`}
          </CardTitle>
          <CardDescription>
            {achados.length === 0
              ? 'As verificações automáticas não encontraram nada fora de lugar. Você ainda pode perguntar o que quiser abaixo.'
              : 'Conferido automaticamente, sem usar inteligência artificial. Pergunte abaixo para entender ou corrigir.'}
          </CardDescription>
        </CardHeader>
        {achados.length > 0 ? (
          <CardContent className="flex flex-col gap-3">
            {achados.map((a) => {
              const Icone = ICONE[a.gravidade];
              return (
                <div key={a.chave} className="flex items-start gap-3">
                  <Icone className={`mt-0.5 h-4 w-4 shrink-0 ${COR[a.gravidade]}`} aria-hidden />
                  <div className="flex flex-col gap-0.5">
                    <p className="text-sm font-medium">{a.titulo}</p>
                    <p className="text-sm text-muted-foreground">{a.detalhe}</p>
                    <p className="text-xs text-muted-foreground">Onde se ajusta: {a.onde}</p>
                  </div>
                </div>
              );
            })}
          </CardContent>
        ) : null}
      </Card>

      {/*
        O que o retrato não conseguiu ler vai à tela, não ao silêncio: o
        assistente responder sem metade do catálogo, sem dizer que não o leu,
        é pior que não responder.
      */}
      {retrato.erros.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Não consegui ler parte da sua conta</CardTitle>
            <CardDescription>
              O assistente vai responder sem esta parte. Se persistir, avise a gente.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-muted-foreground">
              {retrato.erros.map((e) => <li key={e}>{e}</li>)}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      <Conversa promptAtual={retrato.prompt} />
    </div>
  );
}
