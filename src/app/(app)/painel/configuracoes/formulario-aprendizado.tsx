'use client';

import { HelpCircle } from 'lucide-react';
import { useActionState, useState } from 'react';

import { salvarAprendizado, type EstadoConfig } from '../acoes';
import { Alert } from '@/components/ui/alert';
import { SubmitButton } from '@/components/ui/submit-button';

/**
 * O botão do aprendizado automático (01/10).
 *
 * UM interruptor e um `?`. Foi decisão do Felipe que o cliente não revisa
 * frase por frase: ele decide UMA vez se o agente pode aprender com o próprio
 * atendimento. O popup existe porque ligar isto muda o que o agente diz aos
 * clientes dele — a pessoa tem de saber o que está autorizando, e ninguém lê
 * manual.
 */
export function FormularioAprendizado({ ligado }: { ligado: boolean }) {
  const [estado, acao] = useActionState<EstadoConfig, FormData>(salvarAprendizado, {});
  const [ajuda, setAjuda] = useState(false);
  const [marcado, setMarcado] = useState(ligado);

  return (
    <form action={acao} className="flex flex-col gap-4">
      {estado.erro ? <Alert variant="destructive">{estado.erro}</Alert> : null}
      {estado.sucesso ? <Alert variant="success">{estado.sucesso}</Alert> : null}

      <div className="flex items-start gap-3">
        <input
          id="aprendizado"
          name="aprendizado"
          type="checkbox"
          className="mt-1 h-4 w-4"
          checked={marcado}
          onChange={(e) => setMarcado(e.target.checked)}
        />
        <div className="flex flex-col gap-1">
          <label htmlFor="aprendizado" className="flex items-center gap-1.5 text-sm font-medium">
            Aprender com o atendimento da minha equipe
            <button
              type="button"
              onClick={() => setAjuda((v) => !v)}
              aria-expanded={ajuda}
              aria-label="Como funciona o aprendizado automático"
              className="text-muted-foreground hover:text-foreground"
            >
              <HelpCircle className="h-4 w-4" />
            </button>
          </label>
          <p className="text-sm text-muted-foreground">
            Quando ligado, o que seus atendentes respondem vira conteúdo da base automaticamente.
          </p>
        </div>
      </div>

      {ajuda ? (
        <div className="rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
          <p className="font-medium text-foreground">Como funciona</p>
          <ol className="mt-2 flex list-decimal flex-col gap-1.5 pl-5">
            <li>O agente não sabe responder algo e chama um atendente da sua equipe.</li>
            <li>O atendente responde o cliente normalmente, pelo mesmo WhatsApp. Ele não precisa fazer nada diferente.</li>
            <li>
              Quando a conversa termina, o agente guarda aquela pergunta e aquela resposta na sua base de
              conhecimento — e passa a responder sozinho da próxima vez.
            </li>
          </ol>
          <p className="mt-3 font-medium text-foreground">O que ele nunca guarda</p>
          <ul className="mt-2 flex list-disc flex-col gap-1.5 pl-5">
            <li>Resposta com dado pessoal (telefone, CPF, e-mail, endereço) de quem foi atendido.</li>
            <li>
              Resposta que vale só para aquele cliente — &quot;no seu caso são 30 dias porque você entrou em
              agosto&quot; não vira regra para os outros.
            </li>
            <li>&quot;Vou verificar e te retorno&quot;, bom dia e afins: não são informação.</li>
            <li>
              Nada que o agente tenha inventado. O texto guardado é o que o seu atendente escreveu, como ele
              escreveu.
            </li>
          </ul>
          <p className="mt-3">
            Tudo o que entrar aparece em <strong>Base de conhecimento</strong>, com a conversa de origem, e você
            pode editar ou excluir quando quiser. Desligar aqui para o aprendizado na hora; o que já entrou
            continua na base até você remover.
          </p>
        </div>
      ) : null}

      <div>
        <SubmitButton>Salvar</SubmitButton>
      </div>
    </form>
  );
}
