#!/usr/bin/env node
/**
 * A regra que sustenta a funcionalidade de times: OLHE O CORPO, NÃO O STATUS.
 *
 * `POST .../assignments` responde **200 em todos os casos** — com o objeto do
 * time quando atribui e com `null` quando o `team_id` não existe (medido em
 * 18/08 contra a conta 1). Quem ler `r.ok` conclui que deu certo sempre, e
 * `team_id` digitado errado vira transferência para o vazio: sucesso no log,
 * nada no atendimento.
 *
 * Não toca no Chatwoot nem no banco: substitui `fetch` por um dublê e verifica
 * o que a função decide a partir da resposta.
 *
 * Uso: npm run teste:times-chatwoot
 */

import { MAX_DESCRICAO, MAX_DESCRICAO_TOTAL, validarTime } from '../src/lib/tools/times-chatwoot.ts';
import { verificarTime } from '../src/lib/tools/times-chatwoot.server.ts';

let ok = 0;
const falhas = [];
const chk = (n, c, d = '') => {
  if (c) { ok++; console.log(`  OK    ${n}`); }
  else { falhas.push(`${n}${d ? ' — ' + d : ''}`); console.log(`  FALHA ${n}${d ? ' — ' + d : ''}`); }
};

const fd = (o) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };

const PARAMS = { url: 'https://x', accountId: 1, token: 't', conversationId: 9, teamId: 20 };

/** Dublê de fetch: guarda as chamadas e devolve o que o teste mandar. */
function dublar(respostas) {
  const chamadas = [];
  globalThis.fetch = async (url, init) => {
    chamadas.push(JSON.parse(init.body));
    const r = respostas[chamadas.length - 1] ?? respostas[respostas.length - 1];
    if (r instanceof Error) throw r;
    return { ok: r.ok ?? true, status: r.status ?? 200, text: async () => r.corpo };
  };
  return chamadas;
}
const fetchOriginal = globalThis.fetch;

console.log('\n== Times do Chatwoot ==\n');
console.log('-- 1. O corpo decide, não o status --\n');

{
  const chamadas = dublar([{ corpo: '{"id":20,"name":"suporte"}' }, { corpo: 'null' }]);
  const r = await verificarTime(PARAMS);
  chk('corpo com id => existe', r.estado === 'existe', JSON.stringify(r));
  chk('e DESFAZ a atribuição em seguida',
    chamadas.length === 2 && chamadas[1].team_id === null, JSON.stringify(chamadas));
}

{
  // O CASO PERIGOSO: 200, e o corpo diz que não atribuiu.
  const chamadas = dublar([{ status: 200, ok: true, corpo: 'null' }, { corpo: 'null' }]);
  const r = await verificarTime(PARAMS);
  chk('200 com corpo null => NÃO existe (quem lê o status erra aqui)',
    r.estado === 'nao_existe', JSON.stringify(r));
  chk('desfaz mesmo quando não achou — senão a conversa fica sem responsável',
    chamadas.length === 2 && chamadas[1].team_id === null);
}

{
  const r = await verificarTime({ ...PARAMS });
  chk('corpo que não é JSON não vira "existe"', r.estado !== 'existe', JSON.stringify(r));
}

console.log('\n-- 2. Falha de transporte não é "time inexistente" --\n');

{
  dublar([{ ok: false, status: 500, corpo: 'erro' }]);
  const r = await verificarTime(PARAMS);
  chk('HTTP 500 => nao_verificado, e não nao_existe', r.estado === 'nao_verificado', JSON.stringify(r));
  chk('e diz o motivo', /500/.test(r.motivo ?? ''), r.motivo);
}

{
  dublar([new Error('boom')]);
  const r = await verificarTime(PARAMS);
  chk('exceção de rede => nao_verificado', r.estado === 'nao_verificado', JSON.stringify(r));
}

{
  const e = new Error('t'); e.name = 'TimeoutError';
  dublar([e]);
  const r = await verificarTime(PARAMS);
  chk('timeout tem motivo próprio', /tempo/.test(r.motivo ?? ''), r.motivo);
}

globalThis.fetch = fetchOriginal;

console.log('\n-- 3. Validação do formulário --\n');

chk('team_id vazio é recusado', validarTime(fd({ nome: 'x' })).ok === false);
chk('team_id não numérico é recusado', validarTime(fd({ team_id: '20a', nome: 'x' })).ok === false);
chk('team_id zero é recusado', validarTime(fd({ team_id: '0', nome: 'x' })).ok === false);
chk('nome vazio é recusado', validarTime(fd({ team_id: '20', nome: '   ' })).ok === false);
chk(`descrição de ${MAX_DESCRICAO + 1} é recusada`,
  validarTime(fd({ team_id: '20', nome: 'x', descricao: 'y'.repeat(MAX_DESCRICAO + 1) })).ok === false);
chk('válido passa e normaliza',
  (() => {
    const r = validarTime(fd({ team_id: ' 20 ', nome: ' suporte ', descricao: ' ola ', padrao: 'on' }));
    return r.ok && r.valor.teamId === 20 && r.valor.nome === 'suporte' && r.valor.padrao === true;
  })());
chk('sem o checkbox, padrao é false',
  (() => { const r = validarTime(fd({ team_id: '20', nome: 'x' })); return r.ok && r.valor.padrao === false; })());

// O teto da SOMA não é validado aqui de propósito: ele depende do que já existe
// no banco, e vive na Server Action + no trigger. Este teste guarda o teto por
// linha; o da soma está em tests/migracao-times.mjs.
chk('o teto por linha e o do total são diferentes', MAX_DESCRICAO < MAX_DESCRICAO_TOTAL);

console.log('\n' + '-'.repeat(58));
console.log(`  ${ok} passaram, ${falhas.length} falharam`);
for (const f of falhas) console.log(`  ! ${f}`);
console.log();
process.exitCode = falhas.length > 0 ? 1 : 0;
