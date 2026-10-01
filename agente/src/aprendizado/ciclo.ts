/**
 * O ciclo do aprendizado automático — silencioso, uma vez por rodada de
 * manutenção.
 *
 *   api_agente_aprendizado_pendentes  (tenants com o botão ligado; conversa
 *                                      parada há N min; par pergunta/resposta)
 *     -> api_agente_aprendizado_dialogo (as falas daquele atendimento)
 *     -> extrator.extrair()           (A LLM LÊ e julga se há informação da
 *                                      empresa ali — decisão do Felipe, 01/10)
 *     -> filtro.avaliar(.., dialogo)  (a rede: dado pessoal, caso particular,
 *                                      e a ÂNCORA, que mede se o modelo
 *                                      acrescentou fato)
 *     -> [publicar] api_agente_kb_job_texto + Edge Function processar-ingestao
 *     -> api_agente_aprendizado_concluir  (veredito, sempre: publicado,
 *                                          descartado com motivo, ou erro)
 *
 A LLM DECIDE, O CÓDIGO VERIFICA. O modelo lê o diálogo e diz se ali há
 * conhecimento da empresa, qual a pergunta e qual a resposta impessoal — é
 * juízo semântico, e regra de texto erra nos dois sentidos. O que ele NÃO pode
 * é acrescentar fato, e isso não fica confiado ao prompt: `ancorado()` mede
 * quanto da resposta proposta existe no diálogo real e reprova abaixo do piso.
 * Pedir é prompt; medir é código.
 *
 * TODO par recebe veredito, inclusive o recusado. Sem isso o varredor voltaria
 * ao mesmo par em cada rodada, e o motivo da recusa — que é o que o cliente lê
 * para entender por que a base não cresceu — se perderia.
 *
 * Falha de ingestão grava `erro` e NÃO tenta de novo sozinha: a conta da
 * OpenAI é do cliente, e laço de retry silencioso é o jeito mais rápido de
 * gastar o dinheiro dele sem ninguém ver.
 */
import { fnTodas, fnValor, type Db } from '../db.ts';
import { avaliar, textoDaEntrada, tituloDaEntrada } from './filtro.ts';
import { extrair, transcrever, type Fala } from './extrator.ts';
import type { Modelo } from '../agente/modelo.ts';
import { log, erroTexto } from '../log.ts';

export interface Pendente {
  tenant_id: string;
  conversation_id: number | string;
  mensagem_id: string;
  pergunta: string;
  resposta: string;
  criado_em: Date | string;
}

export interface DepsAprendizado {
  db: Db;
  fetchFn: typeof fetch;
  /** Quem lê o diálogo. Sem modelo o ciclo não roda — não há de onde julgar. */
  modelo: Modelo;
  nomeDoModelo: string;
  /** URL do Supabase (a Edge Function mora nela) e o segredo da ingestão. */
  supabaseUrl: string | null;
  ingestaoSecret: string | null;
  /** Quanto tempo a conversa precisa estar parada. */
  silencioMinutos?: number;
  limite?: number;
}

export interface ResultadoCiclo {
  vistos: number;
  publicados: number;
  descartados: number;
  erros: number;
  /** Contagem por motivo de recusa — é o que diz se o filtro está certo. */
  motivos: Record<string, number>;
}

/** Publica um texto na base pelo caminho normal de ingestão. Devolve a origem. */
export async function publicarNaBase(deps: DepsAprendizado, tenantId: string, titulo: string, texto: string): Promise<string> {
  if (!deps.supabaseUrl || !deps.ingestaoSecret) throw new Error('ingestão não configurada no serviço (SUPABASE_URL / INGESTAO_SECRET)');
  const jobId = await fnValor<string>(deps.db, 'api_agente_kb_job_texto', [tenantId, titulo]);
  if (!jobId) throw new Error('api_agente_kb_job_texto não devolveu id');
  const r = await deps.fetchFn(`${deps.supabaseUrl.replace(/\/+$/, '')}/functions/v1/processar-ingestao`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-ingestao-secret': deps.ingestaoSecret },
    body: JSON.stringify({ job_id: jobId, texto }),
  });
  type CorpoIngestao = { ok?: boolean; job?: { status?: string; erro_msg?: string } };
  let corpo: CorpoIngestao | null = null;
  try { corpo = (await r.json()) as CorpoIngestao; } catch { /* sem corpo */ }
  // A função responde 200 mesmo quando o job não conclui: só o `ok` positivo
  // conta, senão gravaríamos "publicado" sem chunk nenhum na base.
  if (!r.ok || corpo?.ok !== true) throw new Error(`ingestão falhou: HTTP ${r.status} ${corpo?.job?.erro_msg ?? ''}`.trim());
  // A Edge Function grava os chunks com esta origem (supabase/functions/
  // processar-ingestao: `origem = texto:${job.id}`) — é o que liga a entrada da
  // base à linha de auditoria e o que o cliente exclui se não quiser.
  return `texto:${jobId}`;
}

export async function cicloAprendizado(deps: DepsAprendizado): Promise<ResultadoCiclo> {
  const r: ResultadoCiclo = { vistos: 0, publicados: 0, descartados: 0, erros: 0, motivos: {} };
  const pendentes = await fnTodas<Pendente>(deps.db, 'api_agente_aprendizado_pendentes', [deps.silencioMinutos ?? 15, deps.limite ?? 20]);
  r.vistos = pendentes.length;

  for (const p of pendentes) {
    const conv = Number(p.conversation_id);
    const recusar = async (motivo: string) => {
      r.descartados++;
      r.motivos[motivo] = (r.motivos[motivo] ?? 0) + 1;
      await concluir(deps, p, conv, 'descartado', motivo, null);
    };

    try {
      // 1. o diálogo daquele atendimento. A janela sai do id da mensagem, no
      //    banco: timestamp que passa por aqui perde microssegundo e a própria
      //    âncora cai fora da janela (medido em 01/10).
      const falas = await fnTodas<Fala>(deps.db, 'api_agente_aprendizado_dialogo', [p.tenant_id, p.mensagem_id]);
      const dialogo = transcrever(falas);

      // 2. a LLM lê e julga
      const e = await extrair(deps.modelo, deps.nomeDoModelo, falas);
      if (!e.guardar) { await recusar(e.motivo ? `modelo: ${e.motivo}`.slice(0, 60) : 'modelo: nao guardar'); continue; }

      // 3. a rede: o que o modelo propôs tem de passar pelo filtro, com a
      //    âncora medindo invenção contra o diálogo que ele leu
      const veredito = avaliar(e.pergunta, e.resposta, dialogo);
      if (!veredito.publicar) { await recusar(veredito.motivo ?? 'desconhecido'); continue; }

      const origem = await publicarNaBase(deps, p.tenant_id, tituloDaEntrada(e.pergunta), veredito.texto ?? textoDaEntrada(e.pergunta, e.resposta));
      await concluir(deps, p, conv, 'publicado', null, origem);
      r.publicados++;
      log('info', 'aprendizado.publicado', { tenant: p.tenant_id, conversa: conv, origem });
    } catch (e) {
      r.erros++;
      await concluir(deps, p, conv, 'erro', erroTexto(e).slice(0, 200), null);
      log('erro', 'aprendizado.falhou', { tenant: p.tenant_id, conversa: conv, erro: erroTexto(e) });
    }
  }
  return r;
}

async function concluir(deps: DepsAprendizado, p: Pendente, conv: number, status: string, motivo: string | null, origem: string | null): Promise<void> {
  try {
    await fnValor(deps.db, 'api_agente_aprendizado_concluir', [p.tenant_id, conv, p.mensagem_id, p.pergunta, p.resposta, status, motivo, origem]);
  } catch (e) {
    // Sem o veredito o par volta na próxima rodada. É ruim, mas é recuperável;
    // derrubar a manutenção inteira por causa de um par não é.
    log('erro', 'aprendizado.veredito_falhou', { tenant: p.tenant_id, conversa: conv, erro: erroTexto(e) });
  }
}
