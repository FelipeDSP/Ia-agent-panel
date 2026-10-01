/**
 * A LEITURA do diálogo — o passo em que o modelo decide se aquele atendimento
 * contém informação que vale para a base.
 *
 * Decisão do Felipe (01/10): a informação passa pela LLM. É ela que lê a
 * conversa entre o atendente e o cliente e julga o que é conhecimento da
 * empresa. E está certo: "isso vale para todo mundo ou só para esta pessoa?"
 * é juízo semântico — regra de texto erra nos dois sentidos (deixa passar
 * "como combinamos ontem" e barra "você precisa trazer RG", que é regra
 * geral).
 *
 * O QUE O MODELO PODE E O QUE NÃO PODE
 *
 * Pode: decidir SE guarda, escolher qual é a pergunta, e recortar a resposta
 * dentro do que foi dito. Não pode: acrescentar fato. Essa fronteira não é
 * confiada ao prompt — o prompt a declara, e quem a MEDE é o `ancorado()` do
 * filtro, que confere depois se a resposta proposta está mesmo dentro do que
 * a conversa continha. Prompt é pedido; âncora é verificação.
 *
 * Por que um modelo barato e uma chamada por atendimento: o volume é o das
 * transferências (25 por quinzena no CEEJAAR), não o das mensagens. Roda na
 * manutenção, fora do caminho da resposta ao cliente — latência aqui não
 * atrasa ninguém.
 */
import type { Modelo } from '../agente/modelo.ts';

export interface Fala { direcao: 'entrada' | 'saida'; conteudo: string; humano: boolean }

export interface Extracao {
  guardar: boolean;
  pergunta: string;
  resposta: string;
  /** O que o modelo disse quando recusou — vai para a auditoria. */
  motivo: string;
}

/**
 * As instruções. Negativas antes das positivas de propósito: o erro caro aqui
 * é guardar o que não devia, não deixar de guardar.
 */
export const INSTRUCOES =
  'Voce le o registro de um atendimento em que um ATENDENTE HUMANO de uma empresa assumiu a conversa '
  + 'com um cliente, e decide se ali ha informacao que deve entrar na base de conhecimento da empresa — '
  + 'aquela que um agente de IA usa para responder OUTROS clientes depois.\n\n'
  + 'NAO GUARDE quando:\n'
  + '- a resposta so vale para aquele cliente (o caso dele, o pedido dele, a matricula dele, uma data que so vale para ele);\n'
  + '- ha dado pessoal de alguem (nome completo, telefone, CPF, e-mail, endereco, numero de pedido ou matricula);\n'
  + '- o atendente nao respondeu de fato ("vou verificar", "ja te retorno", saudacao, combinacao de horario);\n'
  + '- o assunto e preco, valor ou disponibilidade de produto — isso vive no catalogo, nunca na base;\n'
  + '- voce precisaria supor qualquer coisa para completar a resposta.\n\n'
  + 'GUARDE quando o atendente afirmou um fato da empresa que serve para qualquer cliente que perguntar o mesmo: '
  + 'prazo, documento exigido, horario, regra, procedimento, forma de contato institucional.\n\n'
  + 'REGRA ABSOLUTA: a resposta que voce devolver tem de estar CONTIDA no que o atendente escreveu. '
  + 'Voce pode cortar, juntar frases dele e tirar o que for pessoal. Voce NAO pode acrescentar nenhum fato, '
  + 'numero, prazo ou condicao que nao esteja ali. Se faltar informacao, nao guarde.\n\n'
  + 'Responda SOMENTE um JSON, sem cerca de codigo:\n'
  + '{"guardar": true|false, "pergunta": "a duvida em uma frase, como outro cliente faria", '
  + '"resposta": "o que a empresa responde, impessoal, so com o que o atendente disse", "motivo": "por que nao guardar, se guardar=false"}';

/** O diálogo como o modelo o vê. Papéis explícitos: ele precisa saber quem falou. */
export function transcrever(falas: Fala[]): string {
  return falas
    .map((f) => {
      const quem = f.direcao === 'entrada' ? 'CLIENTE' : f.humano ? 'ATENDENTE' : 'AGENTE';
      return `${quem}: ${String(f.conteudo ?? '').replace(/\s+/g, ' ').trim()}`;
    })
    .filter((l) => l.length > 10)
    .join('\n');
}

/** Lê o JSON do modelo sem confiar nele: qualquer desvio vira "não guardar". */
export function lerExtracao(bruto: string): Extracao {
  const texto = String(bruto ?? '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const abre = texto.indexOf('{');
  const fecha = texto.lastIndexOf('}');
  if (abre === -1 || fecha <= abre) return { guardar: false, pergunta: '', resposta: '', motivo: 'resposta do modelo sem JSON' };
  let j: Record<string, unknown>;
  try { j = JSON.parse(texto.slice(abre, fecha + 1)) as Record<string, unknown>; }
  catch { return { guardar: false, pergunta: '', resposta: '', motivo: 'JSON invalido' }; }
  const pergunta = typeof j.pergunta === 'string' ? j.pergunta.trim() : '';
  const resposta = typeof j.resposta === 'string' ? j.resposta.trim() : '';
  const guardar = j.guardar === true && pergunta !== '' && resposta !== '';
  return { guardar, pergunta, resposta, motivo: typeof j.motivo === 'string' ? j.motivo.slice(0, 200) : '' };
}

/**
 * A chamada. Sem ferramentas e sem histórico: é leitura, não conversa — o
 * modelo não tem o que buscar nem com quem falar, e dar-lhe tool aqui seria
 * abrir caminho para ele ir ao banco por conta própria.
 */
export async function extrair(modelo: Modelo, nomeDoModelo: string, falas: Fala[]): Promise<Extracao> {
  const transcricao = transcrever(falas);
  if (transcricao.length < 40) return { guardar: false, pergunta: '', resposta: '', motivo: 'dialogo curto demais' };
  const r = await modelo.responder({
    modelo: nomeDoModelo,
    temperatura: 0,
    systemMessage: INSTRUCOES,
    historico: [],
    mensagemDoCliente: transcricao,
    ferramentas: [],
  });
  return lerExtracao(r.texto ?? '');
}
