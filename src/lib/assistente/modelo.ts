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
  Promise<{ texto: string; uso: UsoTokens; modelo: string; truncado?: boolean }>;
};

/** O modelo do assistente. Não é o do agente: quem escreve prompt precisa ser melhor que quem responde "tem bolo?". */
export const MODELO_PADRAO = 'gpt-4.1';

/**
 * TEMPERATURA BAIXA, e isto saiu de medição, não de gosto.
 *
 * Três chamadas iguais contra a conta do CEEJAAR deram três comportamentos: na
 * primeira ele pediu permissão para propor ("quer ver como fica?"), na segunda
 * propôs, na terceira só conversou e não emitiu o bloco. A tarefa aqui é
 * metade conselho e metade FORMATO — o bloco `<propostas>` com JSON válido —, e
 * formato com temperatura 1.0 é moeda ao ar.
 */
export const TEMPERATURA = 0.2;

/**
 * Teto de saída alto de propósito: uma proposta de prompt contém o prompt
 * INTEIRO reescrito. O do CEEJAAR tem 12,5 KB, que deu 3.679 tokens de saída
 * numa das medições. Sem teto declarado, a resposta pode ser cortada no meio —
 * e o que se perde primeiro é o bloco do fim, que é justamente a proposta.
 */
export const MAX_SAIDA = 12_000;

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
          temperature: TEMPERATURA,
          max_output_tokens: MAX_SAIDA,
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
        status?: string;
        incomplete_details?: { reason?: string };
      };
      // `output_text` é o atalho; o caminho longo existe porque ele não vem em
      // toda versão da API e ficar sem texto por isso seria tela em branco.
      const texto = j.output_text
        ?? (j.output ?? []).flatMap((o) => o.content ?? []).map((c) => c.text ?? '').join('').trim();
      return {
        texto: String(texto ?? ''),
        uso: { entrada: j.usage?.input_tokens ?? 0, saida: j.usage?.output_tokens ?? 0 },
        modelo,
        // Cortado no teto: o que se perde e o FIM da resposta, que e onde mora
        // o bloco de propostas. Quem chama precisa poder dizer isso na tela em
        // vez de o cliente ver conselho sem a correcao prometida.
        truncado: j.status === 'incomplete' && j.incomplete_details?.reason === 'max_output_tokens',
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
