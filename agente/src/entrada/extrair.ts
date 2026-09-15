/**
 * `Extrair e Filtrar`, em código — rodando o MESMO corpo JS que o n8n roda.
 *
 * Durante a transição os dois lados existem, e `n8n/extrair-e-filtrar.js`
 * (com `n8n/filtro-texto.js` injetado no marcador, como o gerador faz) é a
 * ÚNICA fonte da decisão "ignorar / midia / bloqueado / processar". Copiar
 * para TypeScript agora criaria o par fonte↔derivado que este projeto já pagou
 * quatro vezes. Quando o n8n for desligado, isto vira módulo TS de verdade —
 * com `teste:extrair` guardando a equivalência na hora da troca.
 *
 * A imagem do agente carrega a pasta `n8n/` só por causa destes dois arquivos.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface Extraido {
  acao: 'ignorar' | 'midia' | 'bloqueado' | 'processar';
  motivo?: string;
  mensagem?: string;
  conversation_id: number | null;
  chatwoot_account_id: number | null;
  chatwoot_inbox_id: number | null;
  contact_name: string;
  phone: string | null;
  anexo?: { file_type: string | null; data_url: string | null; file_size: number; extensao: string };
}

type Corpo = (ctx: { body: unknown }) => Array<{ json: Extraido }>;

let corpoCompilado: Corpo | null = null;

export function carregarExtrair(n8nJsDir: string): Corpo {
  if (corpoCompilado) return corpoCompilado;
  const extrair = fs.readFileSync(path.join(n8nJsDir, 'extrair-e-filtrar.js'), 'utf8');
  const filtro = fs.readFileSync(path.join(n8nJsDir, 'filtro-texto.js'), 'utf8').trim();
  if (!extrair.includes('// __FILTRO_TEXTO__')) throw new Error('extrair-e-filtrar.js sem o marcador // __FILTRO_TEXTO__');
  const corpo = extrair.replace('// __FILTRO_TEXTO__', filtro);
  // O corpo é o de um nó Code: lê `$json.body` e devolve `[{ json }]`.
  // eslint-disable-next-line no-new-func
  const fn = new Function('$json', corpo) as (ctx: { body: unknown }) => Array<{ json: Extraido }>;
  corpoCompilado = fn;
  return fn;
}

/** O que o n8n devolveria para este webhook. */
export function extrair(n8nJsDir: string, body: unknown): Extraido {
  const saida = carregarExtrair(n8nJsDir)({ body });
  const item = saida[0]?.json;
  if (!item) throw new Error('extrair-e-filtrar.js devolveu vazio');
  return item;
}
