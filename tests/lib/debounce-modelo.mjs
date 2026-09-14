/**
 * MODELO EXECUTÁVEL DO DEBOUNCE — o comportamento ATUAL do n8n, como spec.
 *
 * Fatia 0 da migração (DESENHO-AGENTE-EM-CODIGO.md §4). O grafo real é
 *
 *   Acumula Mensagem (RPUSH) -> Lista Antes (GET) -> Wait Debounce (D s)
 *     -> Lista Depois (GET) -> Ultima Mensagem?
 *          [antes.length == depois.length E depois.length > 0]
 *            sim -> responde(depois) -> Remove Lidos (LPOP x depois.length)
 *            nao -> Acumulo Sumiu? [depois.length == 0] -> ERRO "corrida"
 *                                  senao -> silencio (outra execucao responde)
 *
 * e as condições vêm LIDAS do `agente-principal.json` pelo teste, não de
 * memória. O modelo é uma simulação com relógio falso e Redis falso; cada
 * "execução" tem dois instantes — t0 (push + GET antes) e t0 + D (GET depois +
 * decisão + pops). Eventos no mesmo instante são ordenados pela sequência do
 * cenário, e um cenário que dependa de empate tem de dizê-lo.
 *
 * A INTERFACE é a que o código novo vai implementar também (`Implementacao`):
 * `simular(cenario)` devolve o que aconteceu — respostas (quando, com quais
 * mensagens), erros, e o que sobrou na lista/fila — e o teste compara com o
 * ESPERADO escrito no cenário. Quando o `debounce/janela.ts` existir, ele
 * entra aqui como segunda implementação e os mesmos cenários dizem onde os
 * dois divergem — e a divergência esperada está NOMEADA no cenário.
 */

/** Um cenário: mensagens do cliente (t em segundos) e intervenções. */
export function cenario(nome, { D = 8, eventos, esperado, nota = '' }) {
  return { nome, D, eventos, esperado, nota };
}

/**
 * Implementação n8n (modelo). `eventos`:
 *   { t, tipo: 'msg', texto }          cliente mandou mensagem
 *   { t, tipo: 'humano_assumiu' }      Pausa Conversa -> Limpa Redis Debounce (DEL)
 */
const arred = (t) => Math.round(t * 1000) / 1000;

export function simularN8n({ D, eventos }) {
  let lista = [];                // o Redis: a chave da conversa
  const fila = [];               // eventos futuros: { t, seq, run }
  let seq = 0;
  const saida = { respostas: [], erros: [], silencios: 0 };
  const agendar = (t, run) => { fila.push({ t, seq: seq++, run }); };

  for (const ev of eventos) {
    if (ev.tipo === 'msg') {
      agendar(ev.t, () => {
        // Acumula Mensagem (RPUSH) em t; Lista Antes (GET) 1 ms depois — são
        // dois nós, e é ENTRE eles que a corrida do README acontece (um DEL
        // no mesmo instante da mensagem). Por isso o GET não é atômico com o
        // push aqui.
        lista.push(ev.texto);
        agendar(arred(ev.t + 0.001), () => {
          const antes = lista.length;
          // Wait Debounce, depois Lista Depois + decisão
          agendar(arred(ev.t + D), () => {
            const depois = lista.slice();
            if (antes === depois.length && depois.length > 0) {
              saida.respostas.push({ t: arred(ev.t + D), mensagens: depois });
              for (let i = 0; i < depois.length; i++) lista.shift();   // LPOP x N
            } else if (depois.length === 0) {
              saida.erros.push({ t: arred(ev.t + D), erro: 'Acumulo Sumiu (corrida)', origem: ev.texto });
            } else {
              saida.silencios++;
            }
          });
        });
      });
    } else if (ev.tipo === 'humano_assumiu') {
      agendar(ev.t, () => { lista = []; });                             // DEL
    } else {
      throw new Error(`evento desconhecido: ${ev.tipo}`);
    }
  }

  // Executa em ordem de tempo; empate pela sequência de agendamento.
  while (fila.length) {
    fila.sort((a, b) => a.t - b.t || a.seq - b.seq);
    const { run } = fila.shift();
    run();
  }
  saida.sobrou = lista.slice();
  return saida;
}

/**
 * OS CENÁRIOS. Cada `esperado` descreve o comportamento do n8n HOJE — inclusive
 * o que é brecha. O código novo, quando entrar como segunda implementação,
 * tem de bater em tudo que não estiver marcado como `divergencia_esperada`.
 */
export const CENARIOS = [
  cenario('uma mensagem -> uma resposta, lista vazia depois', {
    eventos: [{ t: 0, tipo: 'msg', texto: 'oi' }],
    esperado: { respostas: [{ t: 8, mensagens: ['oi'] }], erros: 0, sobrou: [] },
  }),
  cenario('duas mensagens dentro da janela -> UMA resposta com as duas, pela segunda execução', {
    eventos: [{ t: 0, tipo: 'msg', texto: 'quero um bolo' }, { t: 3, tipo: 'msg', texto: 'de cenoura' }],
    esperado: { respostas: [{ t: 11, mensagens: ['quero um bolo', 'de cenoura'] }], erros: 0, sobrou: [], silencios: 1 },
  }),
  cenario('três mensagens -> uma resposta com as três, aos 8 s da última', {
    eventos: [{ t: 0, tipo: 'msg', texto: 'a' }, { t: 3, tipo: 'msg', texto: 'b' }, { t: 6, tipo: 'msg', texto: 'c' }],
    esperado: { respostas: [{ t: 14, mensagens: ['a', 'b', 'c'] }], erros: 0, sobrou: [], silencios: 2 },
  }),
  cenario('mensagem DEPOIS da resposta -> segunda resposta própria', {
    eventos: [{ t: 0, tipo: 'msg', texto: 'a' }, { t: 9, tipo: 'msg', texto: 'b' }],
    esperado: { respostas: [{ t: 8, mensagens: ['a'] }, { t: 17, mensagens: ['b'] }], erros: 0, sobrou: [] },
  }),
  cenario('mensagem durante a espera da última -> a resposta ATRASA até 8 s dela e inclui tudo', {
    eventos: [{ t: 0, tipo: 'msg', texto: 'a' }, { t: 7, tipo: 'msg', texto: 'b' }],
    esperado: { respostas: [{ t: 15, mensagens: ['a', 'b'] }], erros: 0, sobrou: [], silencios: 1 },
  }),
  cenario('mensagem chega LOGO DEPOIS da decisão (t=8,01) -> resposta própria; e a mensagem no MESMO instante da decisão entra na anterior', {
    // A ordem no n8n dentro de uma execução é GET depois -> decisão -> LPOP.
    // Uma mensagem cujo RPUSH cai ENTRE o GET e o pop (milissegundos) deixa a
    // execução seguinte com antes=2 e depois=1 -> silêncio -> a mensagem fica
    // presa até a próxima. Esse caso NÃO é representável neste modelo de
    // instantes: fica REGISTRADO como limite, não como coberto — e é uma das
    // razões de a fila com lock por conversa (§3b) substituir isto.
    eventos: [{ t: 0, tipo: 'msg', texto: 'a' }, { t: 8.01, tipo: 'msg', texto: 'b' }],
    esperado: { respostas: [{ t: 8, mensagens: ['a'] }, { t: 16.01, mensagens: ['b'] }], erros: 0, sobrou: [] },
    nota: 'limite do modelo: a brecha GET->pop de milissegundos não é representável',
  }),
  cenario('mensagem no MESMO instante da decisão (empate) -> o RPUSH vence e a resposta atrasa', {
    eventos: [{ t: 0, tipo: 'msg', texto: 'a' }, { t: 8, tipo: 'msg', texto: 'b' }],
    esperado: { respostas: [{ t: 16, mensagens: ['a', 'b'] }], erros: 0, sobrou: [], silencios: 1 },
    nota: 'empate resolvido pela sequência do cenário (a mensagem é agendada antes da decisão pendente)',
  }),
  cenario('A CORRIDA DO README: DEL no mesmo instante da mensagem (entre o RPUSH e o GET antes) -> antes=0, depois=0 -> a guarda d2 barra a resposta vazia e vira erro', {
    // Sem a d2 (`depois.length > 0`), 0 == 0 aprovaria e o agente seria chamado
    // sem prompt — a execução 3951004. O cenário existe para a sabotagem S1.
    eventos: [{ t: 3, tipo: 'msg', texto: 'a' }, { t: 3, tipo: 'humano_assumiu' }],
    esperado: { respostas: [], erros: 1, sobrou: [] },
  }),
  cenario('humano assume durante a espera -> DEL do acúmulo -> a execução pendente morre em "Acumulo Sumiu (corrida)"', {
    eventos: [{ t: 0, tipo: 'msg', texto: 'a' }, { t: 3, tipo: 'humano_assumiu' }],
    esperado: { respostas: [], erros: 1, sobrou: [] },
    nota: 'divergencia_esperada: o código novo trata "humano assumiu" como descarte SILENCIOSO (pausa), não como erro de corrida — hoje toda pausa dentro da janela vira execução vermelha',
  }),
];

/** Compara o que a implementação fez com o esperado do cenário. Devolve lista de diferenças. */
export function conferir(saida, esperado) {
  const difs = [];
  const r = saida.respostas.map((x) => ({ t: x.t, mensagens: x.mensagens }));
  if (JSON.stringify(r) !== JSON.stringify(esperado.respostas)) difs.push(`respostas: ${JSON.stringify(r)} ≠ ${JSON.stringify(esperado.respostas)}`);
  if (saida.erros.length !== (esperado.erros ?? 0)) difs.push(`erros: ${saida.erros.length} ≠ ${esperado.erros ?? 0} (${saida.erros.map((e) => e.erro).join(', ')})`);
  if (JSON.stringify(saida.sobrou) !== JSON.stringify(esperado.sobrou ?? [])) difs.push(`sobrou: ${JSON.stringify(saida.sobrou)} ≠ ${JSON.stringify(esperado.sobrou ?? [])}`);
  if (esperado.silencios !== undefined && saida.silencios !== esperado.silencios) difs.push(`silencios: ${saida.silencios} ≠ ${esperado.silencios}`);
  return difs;
}
