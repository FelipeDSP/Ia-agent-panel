/**
 * MODELO EXECUTÁVEL DA MEMÓRIA — o que o n8n tem no Redis × o que o código
 * novo vai montar de `mensagens_log`. Fatia 0 (DESENHO-AGENTE-EM-CODIGO.md
 * §3b e §4).
 *
 * ---------------------------------------------------------------------------
 * O QUE O N8N FAZ HOJE (lido, não deduzido — commit 5e717f4):
 *
 *   - `Redis Chat Memory` = RedisChatMessageHistory do @langchain/redis com
 *     `sessionTTL = 2400` s: `addMessage` faz push E `EXPIRE` — o prazo é
 *     DESLIZANTE POR ESCRITA; `getMessages` não toca o prazo. O agente
 *     escreve a mensagem do cliente e a resposta a cada turno, então o
 *     relógio só corre no SILÊNCIO: 40 min sem turno e a chave some inteira;
 *   - `contextWindowLength = 20` = `k` do BufferWindowMemory. No LangChain JS,
 *     `k` é o número de INTERAÇÕES e o buffer devolve as últimas `2k`
 *     mensagens (`slice(-k*2)`): 20 pares = 40 mensagens. SUPOSIÇÃO a
 *     conferir na versão instalada do n8n (a mesma ressalva do 5e717f4 sobre
 *     o TTL) — `JANELA_PARES` está isolado por isso;
 *   - o que entra na memória é o texto BRUTO do modelo, porque o nó de memória
 *     vive dentro do agent e o portão roda depois.
 *
 * O QUE O CÓDIGO NOVO FAZ (§3b):
 *
 *   - mesma janela e mesmo silêncio, como PARÂMETROS;
 *   - o silêncio é medido entre mensagens CONSECUTIVAS da conversa, não
 *     "agora − 40 min": a mensagem que acabou de chegar renovaria o prazo e
 *     traria tudo de volta;
 *   - o texto é o PÓS-portão (`mensagens_log.conteudo`), e um corte explícito
 *     (`conversas.memoria_cortada_em`) substitui o DEL do "Limpar Memoria".
 *
 * A DIVERGÊNCIA ESPERADA: no turno em que o portão BARROU, o n8n tem o bruto
 * (`componentes_json.portao.bruto`) e o código tem a substituta. É decisão
 * (§3b), e o teste a nomeia para ninguém "consertar" lendo o bruto.
 *
 * ---------------------------------------------------------------------------
 * O LOG, como entra aqui: linhas `{ direcao: 'entrada'|'saida', criado_em
 * (ms), conteudo, bruto? }` — `bruto` só existe em saída barrada, como no
 * banco. `entrada` e `saida` do mesmo turno têm o MESMO `criado_em` (o
 * `Registra Mensagem` grava as duas numa chamada).
 */

export const SILENCIO_MIN = 40;
export const JANELA_PARES = 20;

const MIN = 60 * 1000;

/** Um evento "limpar memória" do painel: no n8n é DEL da chave, no código é o corte. */
export const LIMPEZA = 'limpeza';

/**
 * O que o Redis do n8n teria no instante `agora`, dado o log e as limpezas.
 * Simula a chave: cada turno faz push das duas mensagens e renova o EXPIRE;
 * silêncio > TTL apaga tudo; DEL (limpeza) apaga tudo; a leitura devolve as
 * últimas 2·k.
 */
export function memoriaN8n(log, { agora, limpezas = [], silencioMin = SILENCIO_MIN, janelaPares = JANELA_PARES } = {}) {
  const eventos = [
    ...agruparTurnos(log).map((t) => ({ t: t.criado_em, tipo: 'turno', turno: t })),
    ...limpezas.map((t) => ({ t, tipo: LIMPEZA })),
  ].sort((a, b) => a.t - b.t);

  let chave = [];
  let expiraEm = -Infinity;
  for (const ev of eventos) {
    if (ev.t > expiraEm) chave = [];                 // o TTL venceu antes deste evento
    if (ev.tipo === LIMPEZA) { chave = []; expiraEm = -Infinity; continue; }
    const { entrada, saida } = ev.turno;
    if (entrada) chave.push({ papel: 'human', texto: entrada.conteudo });
    // O BRUTO: o nó de memória guarda o que o modelo escreveu, antes do portão.
    if (saida) chave.push({ papel: 'ai', texto: saida.bruto ?? saida.conteudo });
    expiraEm = ev.t + silencioMin * MIN;             // EXPIRE a cada escrita
  }
  if (agora > expiraEm) chave = [];
  return chave.slice(-janelaPares * 2);
}

/**
 * O que o código novo monta de `mensagens_log` no instante `agora`.
 */
export function memoriaCodigo(log, { agora, corteEm = null, silencioMin = SILENCIO_MIN, janelaPares = JANELA_PARES } = {}) {
  const turnos = agruparTurnos(log)
    .filter((t) => corteEm === null || t.criado_em > corteEm)
    .sort((a, b) => a.criado_em - b.criado_em);
  // O silêncio é medido entre turnos CONSECUTIVOS (e entre o último e agora).
  let inicio = 0;
  for (let i = 1; i < turnos.length; i++) {
    if (turnos[i].criado_em - turnos[i - 1].criado_em > silencioMin * MIN) inicio = i;
  }
  if (turnos.length && agora - turnos[turnos.length - 1].criado_em > silencioMin * MIN) return [];
  const vivos = turnos.slice(inicio);
  const msgs = [];
  for (const t of vivos) {
    if (t.entrada) msgs.push({ papel: 'human', texto: t.entrada.conteudo });
    // O PÓS-PORTÃO: o que o cliente recebeu. Nunca o bruto.
    if (t.saida) msgs.push({ papel: 'ai', texto: t.saida.conteudo });
  }
  return msgs.slice(-janelaPares * 2);
}

/** Junta entrada+saída do mesmo instante num turno. */
export function agruparTurnos(log) {
  const porInstante = new Map();
  for (const l of log) {
    const k = String(l.criado_em);
    if (!porInstante.has(k)) porInstante.set(k, { criado_em: l.criado_em, entrada: null, saida: null });
    porInstante.get(k)[l.direcao] = l;
  }
  return [...porInstante.values()].sort((a, b) => a.criado_em - b.criado_em);
}
