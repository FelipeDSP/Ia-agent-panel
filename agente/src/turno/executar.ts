/**
 * UM TURNO — o que o worker faz depois de `api_agente_turno_da_conversa`
 * dizer 'responder'. É o caminho do n8n do `Sync Conversa` ao `Registra
 * Mensagem`, com cada passo no trace:
 *
 *   sync -> portão de entrada (a pausa pode ter chegado durante o debounce)
 *   -> mídia (transcrição; avisos por tenant quando não dá)
 *   -> bloqueado? (msg_fora_escopo, sem modelo)
 *   -> perfil -> prompt (hash) -> memória (mensagens_log, pós-portão)
 *   -> MODELO com as tools (loop nosso, usage real)
 *   -> filtro de saída -> componentes -> PORTÃO (aplica-portao.js)
 *   -> envia ao Chatwoot -> nota privada do portão, se houver
 *   -> Registra Mensagem (entrada + saída, execucao_id = turno)
 *
 * O que muda de comportamento em relação ao n8n, e está declarado:
 *   - várias mensagens no debounce viram UM texto (uma por linha), como lá;
 *     mas um áudio no meio é transcrito AQUI, no turno, e não na chegada;
 *   - os avisos de mídia (não suportada/longo/falhou) passam a ser registrados
 *     em `mensagens_log` como saída sem modelo — no n8n só saem no Chatwoot;
 *   - tokens: `usage` REAL da OpenAI; o rateio por componente é PROPORCIONAL
 *     aos caracteres de cada parte (system fixo, prompt do tenant, tools,
 *     memória, mensagens), escalado para o total real. `fonte = 'openai_usage'`.
 */
import { fnUma, fnTodas, fnValor, type Db } from '../db.ts';
import type { Chatwoot } from '../chatwoot/enviar.ts';
import type { Waha } from '../waha/notificar.ts';
import type { Tenant } from '../tenant/resolver.ts';
import { portaoEntrada } from '../pausa/portao-entrada.ts';
import { Turno } from '../trace.ts';
import { resolverPerfil } from '../perfil.ts';
import { montarSystemMessage, versaoDasPartes } from '../agente/prompt.ts';
import type { Modelo, MensagemHistorico } from '../agente/modelo.ts';
import { ferramentasDoPerfil, temPagamento } from '../tools/index.ts';
import type { Asaas } from '../pagamento/asaas.ts';
import type { Embeddings } from '../tools/contexto.ts';
import { transcreverAnexo, type Anexo, type Transcritor } from '../midia/transcrever.ts';
import { saidaLimpa } from './saida.ts';
import { estimarComoN8n, desvioPct } from './estimativa.ts';
import { aplicarPortao } from './portao.ts';
import { digitosDe, lerOferta, secaoOferta } from '../pedido/oferta.ts';
import type { ConfigTool } from '../tools/contexto.ts';

/** Os números que recebem aviso nesta conta (vendas e transferência), em dígitos. */
export async function destinosDeAviso(db: Db, tenantId: string): Promise<string[]> {
  const saida: string[] = [];
  for (const tool of ['vendas', 'transferir_humano']) {
    try {
      const cfg = await fnUma<ConfigTool>(db, 'api_n8n_config_tool', [tenantId, tool]);
      const n = (cfg?.config?.['notificacao'] ?? null) as Record<string, unknown> | null;
      const d = digitosDe(n?.['destino']);
      if (d) saida.push(d);
    } catch { /* sem config: sem destino */ }
  }
  return saida;
}

export interface MensagemDaFila {
  acao: 'processar' | 'midia' | 'bloqueado';
  mensagem: string | null;
  anexo: Anexo | null;
  contact_name: string;
  phone: string | null;
  chatwoot_account_id: number | null;
  chatwoot_inbox_id: number | null;
  message_id: number | null;
}

export interface Deps {
  db: Db; chatwoot: Chatwoot; waha: Waha | null; modelo: Modelo;
  embeddings: Embeddings | null; transcritor: Transcritor | null;
  n8nJsDir: string; versaoCodigo: string; fotoSecret: string | null; fetchFn: typeof fetch;
  /** Pagamento por link; `null` = a tool não entra mesmo contratada. */
  asaas: Asaas | null;
}

export interface ResultadoTurno {
  status: 'ok' | 'descartado' | 'falhou';
  turnoId: string;
  motivo?: string;
  resposta?: string;
  veredito?: string;
}

export interface ConfigDoAgente { memoriaSilencioMinutos: number; memoriaJanelaPares: number; pagamentoFormas: string[] }
export const CONFIG_PADRAO: ConfigDoAgente = { memoriaSilencioMinutos: 40, memoriaJanelaPares: 20, pagamentoFormas: ['PIX'] };

/** `api_agente_config` (66); sem ela ou sem linha, os defaults de antes da 66. */
export async function lerConfigDoAgente(db: Db, tenantId: string): Promise<ConfigDoAgente> {
  try {
    const r = await fnUma<{ memoria_silencio_minutos: number | null; memoria_janela_pares: number | null; pagamento_formas: string[] | null }>(db, 'api_agente_config', [tenantId]);
    if (!r) return CONFIG_PADRAO;
    return {
      memoriaSilencioMinutos: Number(r.memoria_silencio_minutos) || CONFIG_PADRAO.memoriaSilencioMinutos,
      memoriaJanelaPares: Number(r.memoria_janela_pares) || CONFIG_PADRAO.memoriaJanelaPares,
      pagamentoFormas: Array.isArray(r.pagamento_formas) && r.pagamento_formas.length ? r.pagamento_formas : CONFIG_PADRAO.pagamentoFormas,
    };
  } catch {
    return CONFIG_PADRAO;   // 42883 antes da 66: o turno não pode depender da migração
  }
}

/**
 * O que o sistema sabe e o modelo tem de tratar como fato (não como fala do
 * cliente). Hoje: o pagamento confirmado pelo webhook. Devolve `null` quando não
 * há nada a narrar — o item não vai ao modelo e o turno fica igual ao de antes.
 */
export async function narrarEstadoDoSistema(db: Db, tenantId: string, conversationId: number, perfil: string): Promise<string | null> {
  if (perfil !== 'vendas') return null;
  const e = await fnUma<{ pagamento_confirmado: boolean | null; pedido_numero: number | null; pedido_status: string | null }>(db, 'api_n8n_estado_pedido', [tenantId, conversationId, perfil]);
  if (e?.pagamento_confirmado !== true) return null;
  // 71: o banco só devolve `true` para pedido pago, não retirado, há menos de
  // 24 h — o fato nomeia o pedido para o modelo não estendê-lo a um novo.
  const qual = e.pedido_numero ? `do pedido nº ${e.pedido_numero}` : 'do último pedido desta conversa';
  return `FATO DO SISTEMA (do banco, não do cliente): o pagamento ${qual} está CONFIRMADO — `
    + 'o sistema já recebeu e já avisou o cliente com "Pagamento confirmado!". Se o cliente perguntar se caiu, confirme que sim. '
    + 'Isso vale SÓ para esse pedido: um pedido novo começa do zero e não está pago.';
}

/** Sem texto nenhum utilizável (só avisos de mídia): o que dizer. */
const AVISO_PADRAO_MIDIA = 'Ainda não consigo ouvir áudio por aqui. Pode escrever?';

export async function executarTurno(deps: Deps, p: { tenant: Tenant; conversationId: number; filaIds: string[]; mensagens: MensagemDaFila[] }): Promise<ResultadoTurno> {
  const { db, tenant } = { db: deps.db, tenant: p.tenant };
  const { conversationId, mensagens } = p;
  const primeira = mensagens[0];
  if (!primeira) throw new Error('turno sem mensagens');
  const accountId = primeira.chatwoot_account_id;

  const turno = await Turno.abrir(db, {
    tenantId: tenant.tenant_id, conversationId, filaId: p.filaIds[0] ?? null,
    acao: mensagens.some((m) => m.acao === 'bloqueado') ? 'bloqueado' : mensagens.every((m) => m.acao === 'midia') ? 'midia' : 'processar',
    perfil: null, modelo: tenant.modelo, promptHash: null,
  });
  await turno.passo('entrada', 'mensagens', { entrada: { quantidade: mensagens.length, acoes: mensagens.map((m) => m.acao), fila_ids: p.filaIds } });

  const registrar = async (textoEntrada: string, resposta: string, tokens: { entrada: number; saida: number }, audio: number | null, componentes: Record<string, unknown> | null) => {
    const entradaId = await fnValor<string>(db, 'api_n8n_registrar_mensagem',
      [tenant.tenant_id, conversationId, 'entrada', textoEntrada, 0, 0, tenant.modelo, audio, turno.id, null]);
    const saidaId = await fnValor<string>(db, 'api_n8n_registrar_mensagem',
      [tenant.tenant_id, conversationId, 'saida', resposta, tokens.entrada, tokens.saida, tenant.modelo, null, turno.id,
        componentes ? JSON.stringify(componentes) : null]);
    return { entradaId, saidaId };
  };

  try {
    const sync = await turno.medir('registro', 'api_n8n_conversa_sync', { conversationId },
      () => fnUma<{ historico_chars?: number | string | null }>(db, 'api_n8n_conversa_sync', [tenant.tenant_id, conversationId, primeira.contact_name, primeira.phone]));

    // 17/09: o aviso ao dono sai pela inbox do agente, então o dono vira contato
    // nela — e a resposta dele ao aviso chegaria aqui como se fosse cliente. A
    // conversa cujo contato é um destino de aviso (vendas ou transferência)
    // não é atendida: fica no trace como `conversa_do_dono`, sem modelo.
    const foneContato = digitosDe(primeira.phone);
    if (foneContato) {
      const destinos = await destinosDeAviso(db, tenant.tenant_id);
      if (destinos.includes(foneContato)) {
        await turno.passo('portao', 'conversa_do_dono', { saida: { destino: foneContato } });
        await turno.fechar({ status: 'descartado', erro: 'conversa_do_dono' });
        return { status: 'descartado', turnoId: turno.id, motivo: 'conversa_do_dono' };
      }
    }

    const portaoIn = await turno.medir('portao', 'api_n8n_portao_mensagem', { conversationId },
      () => portaoEntrada(db, deps.waha, tenant.tenant_id, conversationId), (r) => r.portao);
    if (!portaoIn.segue) {
      await turno.fechar({ status: 'descartado', erro: `pausada: ${portaoIn.portao.motivo ?? ''}` });
      return { status: 'descartado', turnoId: turno.id, motivo: 'pausada_no_turno' };
    }

    // ---- mídia: transcreve o que for áudio; junta os avisos do que não deu ----
    const textos: string[] = [];
    const avisos: string[] = [];
    let audioSegundos = 0;
    let bloqueado = mensagens.some((m) => m.acao === 'bloqueado');
    for (const m of mensagens) {
      if (m.acao === 'processar' && m.mensagem) textos.push(m.mensagem);
      if (m.acao === 'midia' && m.anexo) {
        const t = await turno.medir('tool', 'transcrever', { file_type: m.anexo.file_type, file_size: m.anexo.file_size },
          () => transcreverAnexo({ db, n8nJsDir: deps.n8nJsDir, tenantId: tenant.tenant_id, conversationId, anexo: m.anexo!, transcritor: deps.transcritor, fetchFn: deps.fetchFn, msgMidiaNaoSuportada: tenant.msg_midia_nao_suportada }),
          // O trace guarda POR QUE não transcreveu: em 16/09 um áudio real levou 65 s e
          // saiu só `{ status: 'falhou' }` — sem o erro, não havia como saber se foi o
          // download, o whisper ou o filtro.
          (r) => ({ status: r.status, ...(r.status === 'ok' ? { chars: r.mensagem.length, audio_segundos: r.audioSegundos, download: r.diagnostico.download } : {}),
            ...('erro' in r && r.erro ? { erro: r.erro } : {}), ...('motivo' in r && r.motivo ? { motivo: r.motivo } : {}) }));
        if (t.status === 'ok') { textos.push(t.mensagem); audioSegundos += t.audioSegundos ?? 0; }
        else if (t.status === 'bloqueado') bloqueado = true;
        else if (t.status === 'vazio') avisos.push(tenant.msg_midia_nao_suportada ?? AVISO_PADRAO_MIDIA);
        else if (t.status === 'nao_contratado' || t.status === 'longo' || t.status === 'falhou') avisos.push(t.avisoAoCliente ?? tenant.msg_midia_nao_suportada ?? AVISO_PADRAO_MIDIA);
      }
    }

    // ---- sem modelo: bloqueio ou só avisos ----
    if (bloqueado || textos.length === 0) {
      const resposta = bloqueado ? (tenant.msg_fora_escopo ?? 'Não posso ajudar com isso.') : (avisos[0] ?? AVISO_PADRAO_MIDIA);
      await turno.passo('modelo', bloqueado ? 'sem-modelo:bloqueado' : 'sem-modelo:aviso-midia', { saida: { texto: resposta } });
      await turno.medir('envio', 'chatwoot.messages', { conversationId, chars: resposta.length },
        () => deps.chatwoot.enviar({ tenantId: tenant.tenant_id, conversationId, content: resposta }));
      const textoEntrada = mensagens.map((m) => m.mensagem ?? (m.acao === 'midia' ? '[áudio]' : '')).filter(Boolean).join('\n');
      const ids = await turno.medir('registro', 'api_n8n_registrar_mensagem', { conversationId },
        () => registrar(textoEntrada, resposta, { entrada: 0, saida: 0 }, audioSegundos || null, { fonte: bloqueado ? 'bloqueado' : 'aviso_midia', chamadas: 0 }));
      await turno.fechar({ status: 'ok', usageEntrada: 0, usageSaida: 0, chamadasModelo: 0, toolsChamadas: 0, mensagensLogSaidaId: ids.saidaId });
      return { status: 'ok', turnoId: turno.id, resposta };
    }

    const textoEntrada = textos.join('\n');

    // ---- perfil, prompt, memória ----
    const { perfil, toolsAtivas } = await turno.medir('registro', 'api_n8n_tools_ativas', {}, () => resolverPerfil(db, tenant.tenant_id));
    // 69: o que ESTA conta oferece (formas de pagar, entrega → atendente) vira
    // seção do prompt; o link só é oferecido ao modelo se a conta aceita link.
    const oferta = perfil === 'vendas'
      ? lerOferta((await fnUma<ConfigTool>(db, 'api_n8n_config_tool', [tenant.tenant_id, 'vendas']))?.config)
      : null;
    const secoesExtras = perfil === 'vendas' && temPagamento(toolsAtivas) && deps.asaas && (oferta?.pagamentos.includes('link') ?? true) ? ['gerar_link_pagamento'] : [];
    const prompt = montarSystemMessage({ perfil, systemPromptDoTenant: tenant.system_prompt, secoesExtras, ...(oferta ? { secaoDinamica: secaoOferta(oferta) } : {}) });
    await fnValor(db, 'api_agente_prompt_registrar', [tenant.tenant_id, prompt.hash, prompt.texto, `${deps.versaoCodigo}/partes:${versaoDasPartes()}`]);
    await turno.prompt(perfil, prompt.hash);
    // 66: silêncio da memória e formas de pagamento são do tenant (agência-only).
    // Sem a função (66 não aplicada), valem os defaults de sempre: 40 min, {PIX}.
    const cfgAgente = await lerConfigDoAgente(db, tenant.tenant_id);
    const memoria = await turno.medir('memoria', 'api_agente_memoria', { conversationId, silencio_min: cfgAgente.memoriaSilencioMinutos },
      () => fnTodas<MensagemHistorico & { criado_em: Date }>(db, 'api_agente_memoria', [tenant.tenant_id, conversationId, cfgAgente.memoriaSilencioMinutos, cfgAgente.memoriaJanelaPares]),
      (r) => ({ mensagens: r.length }));
    await turno.passo('entrada', 'prompt', { entrada: { perfil, tools_ativas: toolsAtivas, prompt_hash: prompt.hash, memoria: memoria.length, texto: textoEntrada } });

    // ---- o estado do sistema que o modelo precisa saber como FATO ----
    // Medido em 16/09 (sendbox, 19:03): com "Pagamento confirmado!" na memória, o
    // modelo ainda respondeu "ainda não apareceu" — a instrução de nunca confirmar
    // pela palavra do cliente pesou mais que uma mensagem antiga do próprio
    // assistente. O banco sabe (`pagamento_confirmado`, o mesmo que o portão lê);
    // então o código NARRA, como item de sistema deste turno. O que o código
    // narra o modelo não precisa deduzir.
    const estadoDoSistema = await narrarEstadoDoSistema(db, tenant.tenant_id, conversationId, perfil);
    if (estadoDoSistema) await turno.passo('registro', 'estado_do_sistema', { saida: { texto: estadoDoSistema } });

    // ---- o modelo ----
    const ctx = { db, tenant, conversationId, accountId, chatwoot: deps.chatwoot, waha: deps.waha, embeddings: deps.embeddings, n8nJsDir: deps.n8nJsDir, fotoSecret: deps.fotoSecret, fetchFn: deps.fetchFn, asaas: deps.asaas, pagamentoFormas: cfgAgente.pagamentoFormas, aceitaLink: oferta?.pagamentos.includes('link') ?? true };
    const ferramentas = ferramentasDoPerfil(ctx, perfil, toolsAtivas);
    const r = await deps.modelo.responder({
      modelo: tenant.modelo ?? 'gpt-4.1-mini', temperatura: tenant.temperatura, systemMessage: prompt.texto, estadoDoSistema,
      historico: memoria.map((m) => ({ papel: m.papel, texto: m.texto })), mensagemDoCliente: textoEntrada, ferramentas,
      aoChamarModelo: (c) => turno.passo('modelo', `openai#${c.iteracao}`, { saida: { texto: c.texto, tool_calls: c.toolCalls, usage: c.uso }, duracaoMs: c.latenciaMs }),
      aoChamarTool: (c) => turno.passo('tool', c.nome, { entrada: c.args, saida: { texto: c.resultado, ...(c.diagnostico === undefined ? {} : { diagnostico: c.diagnostico }) }, erro: c.erro, duracaoMs: c.latenciaMs }),
    });

    // ---- a estimativa do n8n ao lado do real (§5.8) — vai para o trace, não para o log ----
    const estimativa = estimarComoN8n({
      perfil, chamadas: r.chamadas.length, wrapper: prompt.texto.slice(0, prompt.texto.length - (tenant.system_prompt ?? '').length),
      systemPrompt: tenant.system_prompt ?? '', mensagens: textoEntrada, historicoChars: Number(sync?.historico_chars) || 0, textoSaida: r.texto,
    });
    await turno.passo('registro', 'estimativa_n8n', { saida: {
      estimado: estimativa, real: { entrada: r.uso.entrada, saida: r.uso.saida, chamadas: r.chamadas.length },
      desvio_entrada_pct: desvioPct(estimativa.entrada, r.uso.entrada), desvio_saida_pct: desvioPct(estimativa.saida, r.uso.saida),
    } });

    // ---- filtro de saída + componentes (rateio proporcional do total REAL) ----
    const limpa = saidaLimpa(r.texto);
    const chars = {
      wrapper: prompt.texto.length - (tenant.system_prompt ?? '').length,
      system_prompt: (tenant.system_prompt ?? '').length,
      schema_tools: JSON.stringify(ferramentas.map((f) => ({ n: f.nome, d: f.descricao, p: f.parametros }))).length,
      memoria: memoria.reduce((a, m) => a + m.texto.length, 0),
      mensagens: textoEntrada.length,
    };
    const totalChars = Object.values(chars).reduce((a, b) => a + b, 0) || 1;
    const primeiraChamada = r.chamadas[0]?.uso.entrada ?? r.uso.entrada;
    const rateio = (n: number) => Math.round((n / totalChars) * primeiraChamada);
    const componentes: Record<string, unknown> = {
      wrapper: rateio(chars.wrapper), system_prompt: rateio(chars.system_prompt), schema_tools: rateio(chars.schema_tools),
      memoria: rateio(chars.memoria), mensagens: rateio(chars.mensagens),
      round_trip: Math.max(0, r.uso.entrada - primeiraChamada),
      chamadas: r.chamadas.length, fonte: 'openai_usage', real_total: r.uso.entrada + r.uso.saida,
      // 68: vai para `mensagens_log.tokens_entrada_cache` via `api_n8n_registrar_mensagem`.
      entrada_cache: r.uso.entradaCache ?? 0,
      tools: r.tools.map((t) => t.nome), estourou_teto: r.estourouTeto, prompt_hash: prompt.hash,
      ...(limpa.cortes.length ? { saida_cortes: limpa.cortes } : {}),
    };

    // ---- o portão (o MESMO aplica-portao.js) ----
    const portao = await turno.medir('portao', 'aplica-portao.js', { chars: limpa.texto.length, perfil },
      () => aplicarPortao({ db, n8nJsDir: deps.n8nJsDir, tenantId: tenant.tenant_id, conversationId, perfil, textoModelo: limpa.texto, componentes }),
      (s) => ({ veredito: s.veredito, transferir: s.transferir, bruto: s.portao.bruto ?? null }));

    // ---- envia; nota privada se o portão pediu ----
    await turno.medir('envio', 'chatwoot.messages', { conversationId, chars: portao.output.length },
      () => deps.chatwoot.enviar({ tenantId: tenant.tenant_id, conversationId, content: portao.output }));
    if (portao.transferir && portao.notaPrivada) {
      try {
        await turno.medir('envio', 'chatwoot.nota_privada_portao', { conversationId },
          () => deps.chatwoot.enviar({ tenantId: tenant.tenant_id, conversationId, content: portao.notaPrivada!, privada: true }));
      } catch { /* a nota falhar não derruba o turno — a resposta já saiu */ }
    }

    // ---- Registra Mensagem: NÃO é continue — falhar aqui é falhar o turno ----
    const ids = await turno.medir('registro', 'api_n8n_registrar_mensagem', { conversationId },
      () => registrar(textoEntrada, portao.output, r.uso, audioSegundos || null, portao.componentes));

    await turno.fechar({ status: 'ok', usageEntrada: r.uso.entrada, usageSaida: r.uso.saida, chamadasModelo: r.chamadas.length, toolsChamadas: r.tools.length, portaoVeredito: portao.veredito, mensagensLogSaidaId: ids.saidaId });
    return { status: 'ok', turnoId: turno.id, resposta: portao.output, veredito: portao.veredito };
  } catch (e) {
    const erro = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    await turno.fechar({ status: 'falhou', erro });
    return { status: 'falhou', turnoId: turno.id, motivo: erro };
  }
}
