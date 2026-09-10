#!/usr/bin/env node
/**
 * A ARMADILHA DA NOTIFICAÇÃO: "o bot se pausa sozinho".
 *
 * ---------------------------------------------------------------------------
 * O MODO DE FALHA, que é conhecido e não é caso de borda
 *
 * Quando o pagamento cai, alguém precisa mandar uma mensagem que ninguém pediu.
 * Ela sai como `outgoing` no Chatwoot, e o Chatwoot dispara webhook DE VOLTA
 * para o próprio fluxo. O `Roteia Evento` separa bot de humano pelo
 * `sender.type` — e essa condição é o ÚNICO guarda-corpo contra o bot se pausar
 * sozinho. Se a notificação sair por um caminho que não passe por ela, ela
 * PAUSA O AGENTE do cliente, em silêncio.
 *
 * ---------------------------------------------------------------------------
 * COMO ESTE TESTE MEDE, E POR QUE NÃO É UMA CÓPIA DA REGRA
 *
 * Ele NÃO tem a regra escrita dentro dele. Ele LÊ as condições do switch
 * `Roteia Evento` do `agente-principal.json` e as EXECUTA contra payloads
 * sintéticos. Se alguém mexer no switch, este teste muda de resposta junto —
 * que é a diferença entre medir o sistema e medir a minha lembrança dele.
 *
 * É a mesma disciplina do caso dez do CLAUDE.md: derivar o derivado, e executar
 * em vez de comparar texto.
 *
 * ---------------------------------------------------------------------------
 * OS DOIS LADOS, E NENHUM SOZINHO BASTA
 *
 *   1. a notificação enviada com o token de AGENT BOT não é roteada para
 *      `humano` — logo não pausa;
 *   2. a MESMA notificação enviada com token de usuário É roteada para
 *      `humano`, e daquele caminho SE ALCANÇA `Pausa Conversa`.
 *
 * Só (1) passaria numa leitura em que nada nunca é roteado para `humano` — aí a
 * pausa estaria quebrada e o teste diria "seguro". Só (2) não diz nada sobre a
 * notificação.
 *
 * ATENÇÃO AO QUE ELE **NÃO** PROVA: que o Chatwoot de fato carimba
 * `sender.type = 'agent_bot'` para o token que usamos. Isso é comportamento de
 * um serviço externo e só a sandbox responde — está no roteiro da entrega, §5.
 * Aqui fica provado o que é nosso: DADO esse carimbo, o fluxo não pausa.
 *
 * Uso: npm run teste:notificacao-nao-pausa
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WF = JSON.parse(fs.readFileSync(
  path.join(RAIZ, 'n8n', 'workflows', 'agente-principal.json'), 'utf8'));

let ok = 0;
let falhas = 0;
const chk = (nome, cond, det) => {
  if (cond) { ok++; console.log('  OK    ' + nome); }
  else { falhas++; console.log('  FALHA ' + nome + (det ? ' — ' + det : '')); }
};

// ---------------------------------------------------------------------------
// O avaliador do switch, montado a partir do NÓ e não da minha memória.
// ---------------------------------------------------------------------------
const roteia = WF.nodes.find((n) => n.name === 'Roteia Evento');
if (!roteia) { console.log('  FALHA nó "Roteia Evento" ausente'); process.exit(1); }

const regras = roteia.parameters?.rules?.values ?? [];
const fallback = roteia.parameters?.options?.fallbackOutput ?? null;

/** `={{ $json.body.sender?.type ?? '' }}` -> o valor, contra o payload dado. */
function avaliar(expr, $json) {
  const m = String(expr).match(/^=\{\{([\s\S]*)\}\}$/);
  if (!m) return expr;                       // literal, não expressão
  // eslint-disable-next-line no-new-func
  return new Function('$json', `return (${m[1]});`)($json);
}

/**
 * Só os operadores que este switch de fato usa. Um operador novo cai no
 * `throw` em vez de ser tratado como falso — operador desconhecido silenciosamente
 * falso faria toda condição nova "não casar" e o teste seguiria verde.
 */
function comparar(op, esq, dir) {
  const t = `${op.type}:${op.operation}`;
  switch (t) {
    case 'string:equals': return esq === dir;
    case 'string:notEquals': return esq !== dir;
    case 'string:notEmpty': return esq !== undefined && esq !== null && String(esq) !== '';
    case 'string:empty': return esq === undefined || esq === null || String(esq) === '';
    case 'boolean:false': return esq === false;
    case 'boolean:true': return esq === true;
    default: throw new Error(`operador não tratado por este teste: ${t}`);
  }
}

/** Devolve o `outputKey` que o switch escolheria, ou null (fallback). */
function classificar(body) {
  const $json = { body };
  for (const r of regras) {
    const conds = r.conditions?.conditions ?? [];
    const comb = (r.conditions?.combinator ?? 'and').toLowerCase();
    const res = conds.map((cd) => comparar(cd.operator, avaliar(cd.leftValue, $json), cd.rightValue));
    const bateu = comb === 'or' ? res.some(Boolean) : res.every(Boolean);
    if (bateu) return r.renameOutput ? r.outputKey : String(regras.indexOf(r));
  }
  return null;
}

/** Alcança `alvo` a partir da saída `idx` de `origem`? Busca no grafo real. */
function alcanca(origem, idx, alvo) {
  const vistos = new Set();
  const fila = (WF.connections?.[origem]?.main?.[idx] ?? []).map((c) => c.node);
  while (fila.length) {
    const n = fila.shift();
    if (n === alvo) return true;
    if (vistos.has(n)) continue;
    vistos.add(n);
    for (const saida of WF.connections?.[n]?.main ?? []) {
      for (const c of saida ?? []) fila.push(c.node);
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Payloads. O formato é o do webhook do Chatwoot, e os três casos são os que a
// conversa de pagamento produz de verdade.
// ---------------------------------------------------------------------------
const base = {
  event: 'message_created',
  account: { id: 57 },
  conversation: { id: 1864, inbox_id: 282 },
  id: 123456,
  private: false,
};
const doCliente = { ...base, message_type: 'incoming', sender: { type: 'contact' } };
// A notificação de pagamento, enviada com a MESMA credencial do bot — que é o
// que `api_n8n_credencial_chatwoot` devolve e o que o `Envia Mensagem Chatwoot`
// já usa em toda resposta.
const notificacaoBot = { ...base, message_type: 'outgoing', sender: { type: 'agent_bot' } };
// A MESMA notificação, se sair por um token de usuário/admin.
const notificacaoUsuario = { ...base, message_type: 'outgoing', sender: { type: 'user' } };
// E o caso que a pausa existe para pegar: o humano assumindo a conversa.
const humanoDeVerdade = { ...base, message_type: 'outgoing', sender: { type: 'user' } };

console.log('\n== A notificação de pagamento não pausa a conversa ==\n');

console.log(`-- 0. O switch lido do workflow: ${regras.length} regra(s), fallback "${fallback}" --\n`);
chk('as saídas são `cliente` e `humano`',
  regras.map((r) => r.outputKey).join(',') === 'cliente,humano',
  regras.map((r) => r.outputKey).join(','));
chk('o fallback DESCARTA (nada casa -> nada acontece)', fallback === 'none', String(fallback));

console.log('\n-- 1. A notificação com token de bot NÃO é roteada --\n');
{
  const r = classificar(notificacaoBot);
  chk('`agent_bot` outgoing não vira `humano`', r !== 'humano', String(r));
  chk('e também não vira `cliente` (é outgoing)', r !== 'cliente', String(r));
  chk('ou seja: cai no fallback e é descartada', r === null, String(r));
}

console.log('\n-- 2. O ESPELHO: por token de usuário, ela PAUSA --\n');
{
  const r = classificar(notificacaoUsuario);
  chk('`user` outgoing É roteado para `humano`', r === 'humano', String(r));
  const idx = regras.findIndex((x) => x.outputKey === 'humano');
  chk('e da saída `humano` SE ALCANÇA `Pausa Conversa` no grafo real',
    alcanca('Roteia Evento', idx, 'Pausa Conversa'), `saída ${idx}`);
  // Sem esta metade, a §1 passaria numa leitura em que NADA nunca é roteado
  // para `humano` — a pausa estaria quebrada e o teste diria "seguro".
}

console.log('\n-- 3. O que a pausa existe para pegar continua sendo pego --\n');
chk('humano de verdade assumindo a conversa -> `humano`',
  classificar(humanoDeVerdade) === 'humano');
chk('mensagem do cliente -> `cliente`', classificar(doCliente) === 'cliente');
chk('nota privada do cliente não entra',
  classificar({ ...doCliente, private: true }) !== 'cliente');

console.log('\n-- 4. Sender ausente também não pausa --\n');
// Nem toda criação de mensagem pelo Chatwoot carimba `sender`. A condição
// `notEmpty` é o segundo guarda-corpo, e ela é fácil de perder de vista.
chk('outgoing sem `sender` cai no fallback',
  classificar({ ...base, message_type: 'outgoing' }) === null);
chk('outgoing com `sender.type` vazio cai no fallback',
  classificar({ ...base, message_type: 'outgoing', sender: { type: '' } }) === null);

console.log('\n-- 5. SABOTAGEM: tirar cada guarda-corpo, uma de cada vez --\n');
//
// AS DUAS CONDIÇÕES PROTEGEM PAYLOADS DIFERENTES, e escrevi a primeira versão
// desta seção como se protegessem o mesmo — sondando as duas com a notificação
// do bot. Ela ficou vermelha, e estava certa: tirar o `notEmpty` não faz a
// notificação do bot pausar, porque quem a barra é a condição `agent_bot`.
//
//   `agent_bot` (ev6)  guarda a mensagem QUE O BOT MANDA;
//   `notEmpty`  (ev8)  guarda a mensagem criada SEM `sender` — que existe, e é
//                      o caminho por onde uma automação de fora entraria.
//
// Cada sabotagem sonda o payload que a SUA condição protege. Sondar o payload
// errado transformaria a segunda linha num falso vermelho — e "ajustar o
// esperado até ficar verde" é como uma guarda de verdade some.
{
  const idx = regras.findIndex((x) => x.outputKey === 'humano');
  const original = JSON.stringify(regras[idx]);
  const semSender = { ...base, message_type: 'outgoing' };

  const CASOS = [
    { alvo: 'agent_bot', tira: (cd) => cd.rightValue !== 'agent_bot', sonda: notificacaoBot,
      diz: 'a notificação do BOT passa a pausar' },
    { alvo: 'notEmpty', tira: (cd) => cd.operator?.operation !== 'notEmpty', sonda: semSender,
      diz: 'a mensagem SEM `sender` passa a pausar' },
  ];

  for (const cs of CASOS) {
    const copia = JSON.parse(original);
    const antes = copia.conditions.conditions.length;
    copia.conditions.conditions = copia.conditions.conditions.filter(cs.tira);
    const depois = copia.conditions.conditions.length;
    // CONFIRMA QUE A MUTAÇÃO ENTROU antes de acreditar no resultado.
    if (depois !== antes - 1) {
      falhas++;
      console.log(`  FALHA sabotagem "${cs.alvo}" não removeu nada (${antes} -> ${depois})`);
      continue;
    }
    console.log(`     [mutou "${cs.alvo}": ${antes} -> ${depois} condições]`);
    regras[idx] = copia;
    const r = classificar(cs.sonda);
    // E o CONTRASTE: com a condição no lugar, o mesmo payload não pausa.
    regras[idx] = JSON.parse(original);
    const bom = classificar(cs.sonda);
    chk(`SABOTAGEM sem \`${cs.alvo}\` -> ${cs.diz}`, r === 'humano', String(r));
    chk(`  ...e com ela no lugar, o mesmo payload NÃO pausa`, bom !== 'humano', String(bom));
  }

  chk('e o nó foi restaurado byte a byte', JSON.stringify(regras[idx]) === original);
}

console.log(`\n${'-'.repeat(60)}`);
console.log(`  ${ok} passaram, ${falhas} falharam`);
process.exit(falhas ? 1 : 0);
