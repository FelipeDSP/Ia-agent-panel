/**
 * O MODELO — SDK da OpenAI direto, Responses API, loop de tools NOSSO
 * (DESENHO §3b). O que o LangChain fazia às escondidas está escrito aqui:
 *
 *   - teto de iterações explícito (`MAX_ITERACOES`);
 *   - tool + texto na mesma resposta: as tools executam e o texto é ignorado —
 *     a resposta final é a do ciclo em que o modelo NÃO chamou tool nenhuma;
 *   - resultado de tool volta como STRING (`function_call_output`), o que a
 *     ferramenta devolveu, sem embrulho;
 *   - `usage` REAL por chamada, somado; e cada chamada e cada tool vão para o
 *     trace por quem chama (`aoChamarModelo`, `aoChamarTool`).
 *
 * `store: false`: nada fica guardado do lado da OpenAI; o histórico inteiro
 * (memória + turno + tool calls) viaja a cada iteração.
 *
 * A interface `Modelo` é de um arquivo, de propósito: o teste injeta um falso
 * e o dia em que o provedor mudar, muda-se aqui.
 */
import OpenAI from 'openai';

export interface MensagemHistorico { papel: 'human' | 'ai'; texto: string }

export interface FerramentaDoModelo {
  nome: string;
  descricao: string;
  /** JSON Schema do objeto de argumentos (strict: todas as propriedades em `required`; opcionais como `['tipo','null']`). */
  parametros: Record<string, unknown>;
  /**
   * O texto volta ao modelo. `diagnostico` (opcional) vai SÓ ao trace: o que a
   * tool fez de fato (pausou? notificou? em quantas tentativas?) — em 16/09 a
   * transferência gravava só o texto e não dava para saber se a pausa entrou.
   */
  executar: (args: Record<string, unknown>) => Promise<string | ResultadoTool>;
}

export interface ResultadoTool { texto: string; diagnostico?: unknown }

export interface Uso { entrada: number; saida: number }

export interface ChamadaModelo { iteracao: number; uso: Uso; toolCalls: number; latenciaMs: number; texto: string | null }
export interface ChamadaTool { nome: string; args: Record<string, unknown>; resultado: string; latenciaMs: number; erro: string | null; diagnostico?: unknown }

export interface ResultadoModelo {
  texto: string;
  uso: Uso;
  chamadas: ChamadaModelo[];
  tools: ChamadaTool[];
  /** true se parou pelo teto de iterações (o texto é o que se conseguiu). */
  estourouTeto: boolean;
}

export interface PedidoAoModelo {
  modelo: string;
  temperatura: number | null;
  systemMessage: string;
  /**
   * Fatos do SISTEMA para este turno (ex.: "o pagamento está confirmado"), vindos
   * do banco — vão como item `system` DEPOIS do histórico, para o modelo não os
   * confundir com fala do cliente nem com memória antiga. Fora do hash do prompt:
   * mudam por turno, o prompt não.
   */
  estadoDoSistema?: string | null;
  historico: MensagemHistorico[];
  mensagemDoCliente: string;
  ferramentas: FerramentaDoModelo[];
  aoChamarModelo?: (c: ChamadaModelo) => Promise<void>;
  aoChamarTool?: (c: ChamadaTool) => Promise<void>;
}

export interface Modelo {
  responder(p: PedidoAoModelo): Promise<ResultadoModelo>;
}

export const MAX_ITERACOES = 10;

/** Texto quando o teto estoura sem resposta final — o modelo não responde por conta própria aqui. */
export const TEXTO_TETO = 'Desculpe, não consegui concluir agora. Pode repetir o que precisa? Se preferir, posso chamar um atendente.';

export function criarModeloOpenAI(apiKey: string): Modelo {
  const client = new OpenAI({ apiKey });
  return {
    async responder(p) {
      const ferramentasPorNome = new Map(p.ferramentas.map((f) => [f.nome, f]));
      const tools = p.ferramentas.map((f) => ({
        type: 'function' as const, name: f.nome, description: f.descricao, parameters: f.parametros, strict: true,
      }));
      // O histórico: pares human/ai da memória (mensagens_log, pós-portão), depois a mensagem do turno.
      const input: OpenAI.Responses.ResponseInputItem[] = [
        ...p.historico.map((m) => ({ role: m.papel === 'human' ? 'user' as const : 'assistant' as const, content: m.texto })),
        ...(p.estadoDoSistema ? [{ role: 'system' as const, content: p.estadoDoSistema }] : []),
        { role: 'user', content: p.mensagemDoCliente },
      ];
      const uso: Uso = { entrada: 0, saida: 0 };
      const chamadas: ChamadaModelo[] = [];
      const toolsFeitas: ChamadaTool[] = [];

      for (let iteracao = 1; iteracao <= MAX_ITERACOES; iteracao++) {
        const t0 = Date.now();
        const resp = await client.responses.create({
          model: p.modelo,
          instructions: p.systemMessage,
          input,
          tools,
          ...(p.temperatura !== null && p.temperatura !== undefined ? { temperature: Number(p.temperatura) } : {}),
          store: false,
        });
        uso.entrada += resp.usage?.input_tokens ?? 0;
        uso.saida += resp.usage?.output_tokens ?? 0;
        const calls = resp.output.filter((o): o is OpenAI.Responses.ResponseFunctionToolCall => o.type === 'function_call');
        const texto = resp.output_text?.trim() || null;
        const c: ChamadaModelo = { iteracao, uso: { entrada: resp.usage?.input_tokens ?? 0, saida: resp.usage?.output_tokens ?? 0 }, toolCalls: calls.length, latenciaMs: Date.now() - t0, texto };
        chamadas.push(c);
        if (p.aoChamarModelo) await p.aoChamarModelo(c);

        if (calls.length === 0) {
          return { texto: texto ?? '', uso, chamadas, tools: toolsFeitas, estourouTeto: false };
        }

        // Tool + texto na mesma resposta: executa as tools; o texto desta
        // iteração NÃO vai ao cliente (a resposta final é a da última).
        for (const call of calls) input.push(call);
        for (const call of calls) {
          const f = ferramentasPorNome.get(call.name);
          let args: Record<string, unknown> = {};
          try { args = call.arguments ? (JSON.parse(call.arguments) as Record<string, unknown>) : {}; } catch { args = {}; }
          const t1 = Date.now();
          let resultado: string; let erro: string | null = null; let diagnostico: unknown = undefined;
          if (!f) {
            resultado = `Ferramenta desconhecida: ${call.name}.`;
            erro = 'ferramenta_desconhecida';
          } else {
            try { const r = await f.executar(args); if (typeof r === 'string') resultado = r; else { resultado = r.texto; diagnostico = r.diagnostico; } }
            catch (e) { erro = e instanceof Error ? `${e.name}: ${e.message}` : String(e); resultado = 'A ferramenta falhou agora. NAO invente o resultado; diga ao cliente que nao conseguiu e ofereca tentar de novo ou transferir.'; }
          }
          const ct: ChamadaTool = { nome: call.name, args, resultado, latenciaMs: Date.now() - t1, erro, ...(diagnostico === undefined ? {} : { diagnostico }) };
          toolsFeitas.push(ct);
          if (p.aoChamarTool) await p.aoChamarTool(ct);
          input.push({ type: 'function_call_output', call_id: call.call_id, output: resultado });
        }
      }
      return { texto: TEXTO_TETO, uso, chamadas, tools: toolsFeitas, estourouTeto: true };
    },
  };
}
