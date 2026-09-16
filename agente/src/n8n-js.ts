/**
 * Executor dos corpos JS que continuam sendo FONTE durante a transição.
 *
 * `aplica-portao.js`, `busca-kb-consolida.js`, `enviar-foto-resposta.js`,
 * `filtra-transcricao.js`, `tool-pagamento-resposta.js` e `extrair-e-filtrar.js`
 * são os mesmos arquivos que o n8n injeta em nós Code — e são testados pela
 * suíte executando exatamente estes corpos. Reescrevê-los em TS agora criaria
 * o par fonte↔derivado que o projeto pagou quatro vezes. Então o serviço os
 * compila UMA vez e os roda com o mesmo contrato do n8n: `$input.first().json`,
 * `$input.all()`, `$json` e `$('Nó').first().json`.
 *
 * Quando o n8n for desligado, cada um vira módulo TS de verdade — com o teste
 * que já existe guardando a equivalência na hora da troca.
 */
import fs from 'node:fs';
import path from 'node:path';

type Corpo = (input: unknown, $: unknown, $json: unknown) => Array<{ json: Record<string, unknown> }>;

const cache = new Map<string, Corpo>();

export function corpoN8n(dir: string, arquivo: string, opcoes: { injetarFiltro?: boolean } = {}): Corpo {
  const chave = `${dir}/${arquivo}`;
  const pronto = cache.get(chave);
  if (pronto) return pronto;
  let corpo = fs.readFileSync(path.join(dir, arquivo), 'utf8');
  if (opcoes.injetarFiltro) {
    const filtro = fs.readFileSync(path.join(dir, 'filtro-texto.js'), 'utf8').trim();
    if (!corpo.includes('// __FILTRO_TEXTO__')) throw new Error(`${arquivo} sem o marcador // __FILTRO_TEXTO__`);
    corpo = corpo.replace('// __FILTRO_TEXTO__', filtro);
  }
  // eslint-disable-next-line no-new-func
  const fn = new Function('$input', '$', '$json', corpo) as Corpo;
  cache.set(chave, fn);
  return fn;
}

/**
 * Roda um corpo com um item de entrada e um mapa de nós referenciados por nome.
 * Nó pedido e não previsto lança — igual ao n8n, que erra em vez de devolver
 * vazio quando `$('X')` não existe.
 */
export function rodarN8n(corpo: Corpo, entrada: { json: Record<string, unknown> } | Array<{ json: Record<string, unknown> }>, nos: Record<string, unknown> = {}): Record<string, unknown> {
  const itens = Array.isArray(entrada) ? entrada : [entrada];
  const $input = { first: () => itens[0], all: () => itens, last: () => itens[itens.length - 1] };
  const $ = (nome: string) => {
    if (!(nome in nos)) throw new Error(`corpo n8n pediu o nó "${nome}", que o serviço não fornece`);
    return { first: () => ({ json: nos[nome] }), item: { json: nos[nome] } };
  };
  const saida = corpo($input, $, itens[0]?.json);
  const item = saida?.[0]?.json;
  if (!item) throw new Error('corpo n8n devolveu vazio');
  return item;
}
