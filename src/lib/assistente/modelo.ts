import 'server-only';

/**
 * A chamada à OpenAI do assistente do painel — por `fetch`, sem SDK.
 *
 * O painel não tem o pacote `openai` nas dependências e não vai ter por causa
 * de uma chamada: são 20 linhas de `fetch` contra uma dependência a mais no
 * bundle do Next e um lockfile a mais para manter. O serviço `agente/` usa o
 * SDK porque lá tem loop de tools, retry e streaming; aqui é uma ida e volta.
 *
 * `store: false` como no agente: nada do que o cliente escreve fica guardado do
 * lado da OpenAI.
 *
 * A INTERFACE EXISTE PARA O TESTE. `ModeloAssistente` é o costurão: o teste
 * injeta um dublê e mede o turno inteiro sem gastar token e sem depender da
 * rede. Teste que chama a OpenAI de verdade é teste que ninguém roda.
 */

export type UsoTokens = { entrada: number; saida: number };

export type ModeloAssistente = {
  responder(p: { instrucoes: string; mensagens: { papel: 'user' | 'assistant'; texto: string }[] }):
  Promise<{ texto: string; uso: UsoTokens; modelo: string }>;
};

/** O modelo do assistente. Não é o do agente: quem escreve prompt precisa ser melhor que quem responde "tem bolo?". */
export const MODELO_PADRAO = 'gpt-4.1';

export function criarModeloOpenAI(apiKey: string, modelo = MODELO_PADRAO): ModeloAssistente {
  return {
    async responder(p) {
      const r = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: modelo,
          instructions: p.instrucoes,
          input: p.mensagens.map((m) => ({ role: m.papel, content: m.texto })),
          store: false,
        }),
      });
      if (!r.ok) {
        // A mensagem da OpenAI entra no erro porque ela diz a coisa útil
        // ("model not found", "insufficient quota") e sem ela o diagnóstico
        // vira adivinhação. Não há segredo aqui: a chave não volta na resposta.
        const corpo = await r.text().catch(() => '');
        throw new Error(`OpenAI ${r.status}: ${corpo.slice(0, 300)}`);
      }
      const j = await r.json() as {
        output_text?: string;
        output?: { content?: { text?: string }[] }[];
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      // `output_text` é o atalho; o caminho longo existe porque ele não vem em
      // toda versão da API e ficar sem texto por isso seria tela em branco.
      const texto = j.output_text
        ?? (j.output ?? []).flatMap((o) => o.content ?? []).map((c) => c.text ?? '').join('').trim();
      return {
        texto: String(texto ?? ''),
        uso: { entrada: j.usage?.input_tokens ?? 0, saida: j.usage?.output_tokens ?? 0 },
        modelo,
      };
    },
  };
}

/**
 * O modelo configurado, ou `null`.
 *
 * `null` NÃO é falha: é a resposta honesta de um painel que ainda não recebeu
 * `OPENAI_API_KEY` no ambiente. Quem chama transforma isso em "o assistente não
 * está configurado" na tela, em vez de estourar 500 — é o mesmo desenho do
 * `/testar` do agente, que devolve 503 sem `TESTE_SECRET`.
 */
export function modeloDoAmbiente(): ModeloAssistente | null {
  const chave = process.env['OPENAI_API_KEY']?.trim();
  if (!chave) return null;
  return criarModeloOpenAI(chave, process.env['ASSISTENTE_MODELO']?.trim() || MODELO_PADRAO);
}
