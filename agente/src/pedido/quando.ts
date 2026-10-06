/**
 * O "quando" do pedido: de `2026-10-07 07:00` no fuso da loja para um instante.
 *
 * POR QUE ISTO EXISTE (06/10/2026). Os quatro últimos pedidos do Empório
 * guardaram o horário em quatro formatos diferentes — `{"entrega":"pela
 * manhã"}`, `{"horario":"manhã"}`, `{"observacao":"Retirada às 7h15"}` —
 * porque `metadados` é jsonb livre e o modelo inventa a chave. "O que vai sair
 * hoje" é uma pergunta sobre hora, e não se ordena texto solto.
 *
 * O MODELO NÃO FAZ CONTA DE FUSO. Ele manda `YYYY-MM-DDTHH:MM` no horário da
 * loja — que é o que ele ouviu do cliente e o que o relógio do sistema lhe deu
 * desde 04/10 — e a conversão para UTC é feita aqui, deterministicamente.
 * Pedir ISO com offset ao modelo seria pedir a ele que resolvisse horário de
 * verão e `-04:00` contra `-03:00`, que é exatamente o tipo de conta que ele
 * erra em silêncio.
 *
 * O resultado entra em `metadados.quando_em`, e o trigger da migração 83 copia
 * para a coluna. Nenhuma assinatura de função viva muda — a armadilha das
 * migrações 28/32/37.
 */

const FORMATO = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/;

/** O deslocamento do fuso, em minutos, NAQUELE instante (respeita horário de verão). */
function offsetMinutos(tz: string, utc: Date): number {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const p = Object.fromEntries(f.formatToParts(utc).map((x) => [x.type, x.value]));
  const comoLocal = Date.UTC(
    Number(p['year']), Number(p['month']) - 1, Number(p['day']),
    Number(p['hour']) % 24, Number(p['minute']), Number(p['second']),
  );
  return (comoLocal - utc.getTime()) / 60000;
}

/**
 * `texto` no fuso `tz` -> instante UTC em ISO, ou null se não der para ler.
 *
 * Null não é erro: é "ninguém combinou hora". A venda não pode cair porque o
 * modelo escreveu "manhã" — perder o pedido para ganhar a agenda seria trocar
 * um problema por um pior.
 */
export function resolverQuando(texto: string | null | undefined, tz: string): string | null {
  const m = FORMATO.exec(String(texto ?? '').trim());
  if (!m) return null;
  const [, a, mes, d, h, min] = m;
  const ano = Number(a); const mm = Number(mes); const dd = Number(d);
  const hh = Number(h); const mi = Number(min);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31 || hh > 23 || mi > 59) return null;

  const comoSeFosseUtc = Date.UTC(ano, mm - 1, dd, hh, mi);
  // Duas passadas: o offset depende do instante, e o instante depende do
  // offset. A segunda passada acerta a virada do horário de verão — sem ela, um
  // pedido marcado para a hora da virada cairia uma hora fora.
  let utc = comoSeFosseUtc - offsetMinutos(tz, new Date(comoSeFosseUtc)) * 60000;
  utc = comoSeFosseUtc - offsetMinutos(tz, new Date(utc)) * 60000;

  const dt = new Date(utc);
  if (Number.isNaN(dt.getTime())) return null;
  // Data que o calendário não tem (31/02) volta normalizada pelo Date; recusar
  // é melhor do que gravar 03/03 por conta própria.
  const conferir = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(dt);
  const p = Object.fromEntries(conferir.map((x) => [x.type, x.value]));
  if (Number(p['day']) !== dd || Number(p['month']) !== mm || Number(p['year']) !== ano) return null;

  return dt.toISOString();
}

/** O texto da agenda para o cliente ler na confirmação, no fuso da loja. */
export function narrarQuando(iso: string, tz: string): string {
  const d = new Date(iso);
  const f = new Intl.DateTimeFormat('pt-BR', {
    timeZone: tz, weekday: 'long', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return `${p['weekday']}, ${p['day']}/${p['month']} às ${p['hour']}:${p['minute']}`;
}
