#!/usr/bin/env node
/**
 * O roteamento da pausa decide certo — contra os payloads REAIS do webhook.
 *
 * POR QUE ESTE TESTE EXISTE. O bug que ele guarda ficou meses invisível porque
 * a execução do n8n ficava VERDE: o evento entrava, morria numa condição (ou
 * numa saída sem destino) e a execução terminava sem erro. Não havia como
 * distinguir "não devia pausar" de "não conseguiu pausar" olhando o n8n. Este
 * teste faz essa distinção fora dele.
 *
 * ELE LÊ AS CONDIÇÕES DO JSON, não uma cópia delas. Se alguém reeditar o
 * `Roteia Evento` pela UI e reexportar, o teste passa a exercitar o que
 * REEXPORTOU. Uma cópia das regras aqui dentro passaria a testar a si mesma.
 *
 * PROVENIÊNCIA DOS PAYLOADS. Os dois que decidem o conserto são reais, colhidos
 * das execuções de 2026-08-20 (10:18:06 e 14:37) e citados campo a campo. Os
 * demais estão marcados `derivado`: só têm os campos que o roteador LÊ
 * (`event`, `message_type`, `private`, `sender`, `content`), porque é só isso
 * que decide o caminho — e inventar o resto daria falsa impressão de payload
 * real. O da nota privada vem do corpo do nó `Nota Privada no Chatwoot` do
 * `Tool - Transferir para Humano`, que é código versionado.
 *
 * Uso: node tests/pausa-roteamento.mjs [arquivo.json]
 */

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = fileURLToPath(new URL('../', import.meta.url));
const ARQ = process.argv[2] || path.join(RAIZ, 'n8n', 'importar', 'agente-principal-pausa.json');

const NO_SWITCH = 'Roteia Evento';
const NO_IF = 'Fala com o Cliente?';

/* ------------------------------------------------------------------ avaliador */

/**
 * Resolve `={{ ... }}` do jeito que o n8n resolve: JS com `$json` no escopo.
 *
 * Estourar aqui é RESULTADO, não acidente — o caso "payload sem sender" existe
 * justamente para provar que a expressão não estoura. Por isso o erro vira um
 * valor (`{ estourou }`) em vez de derrubar o processo.
 */
const resolver = (valor, $json) => {
  if (typeof valor !== 'string' || !valor.startsWith('=')) return { v: valor };
  const expr = valor.slice(1).replace(/^\{\{/, '').replace(/\}\}$/, '');
  try {
    // eslint-disable-next-line no-new-func
    return { v: new Function('$json', `return (${expr})`)($json) };
  } catch (e) {
    return { estourou: e.message };
  }
};

const aplicarOperador = (op, esq, dir, caseSensitive) => {
  const s = (x) => (caseSensitive ? String(x) : String(x).toLowerCase());
  switch (`${op.type}:${op.operation}`) {
    case 'string:equals': return s(esq) === s(dir);
    case 'string:notEquals': return s(esq) !== s(dir);
    case 'string:contains': return s(esq).includes(s(dir));
    case 'string:notEmpty': return esq !== undefined && esq !== null && String(esq) !== '';
    case 'boolean:false': return esq === false || (esq !== true && !esq);
    case 'boolean:true': return esq === true;
    default: throw new Error(`operador nao suportado no simulador: ${op.type}:${op.operation}`);
  }
};

/** Avalia um bloco `conditions` do n8n. Devolve true/false ou { estourou }. */
const avaliarBloco = (bloco, $json) => {
  const caseSensitive = bloco.options?.caseSensitive !== false;
  const resultados = [];
  for (const c of bloco.conditions) {
    const esq = resolver(c.leftValue, $json);
    if (esq.estourou) return { estourou: `${c.id}: ${esq.estourou}` };
    const dir = resolver(c.rightValue, $json);
    if (dir.estourou) return { estourou: `${c.id}: ${dir.estourou}` };
    try {
      resultados.push(aplicarOperador(c.operator, esq.v, dir.v, caseSensitive));
    } catch (e) {
      return { estourou: `${c.id}: ${e.message}` };
    }
  }
  return bloco.combinator === 'or' ? resultados.some(Boolean) : resultados.every(Boolean);
};

/**
 * Percorre Webhook -> Roteia Evento -> (cliente | Fala com o Cliente?) e devolve
 * o NOME do nó onde o item para. `null` = não saiu por nenhuma porta, que é o
 * caso silencioso que este teste existe para tornar visível.
 */
const rotear = (wf, body) => {
  const no = (n) => wf.nodes.find((x) => x.name === n);
  const destino = (nome, saida) => wf.connections[nome]?.main?.[saida]?.[0]?.node ?? null;
  const $json = { body };

  const sw = no(NO_SWITCH);
  if (!sw) return { erro: `no "${NO_SWITCH}" ausente` };

  let saida = null;
  const regras = sw.parameters.rules.values;
  for (let i = 0; i < regras.length; i++) {
    const r = avaliarBloco(regras[i].conditions, $json);
    if (r && r.estourou) return { estourou: `${NO_SWITCH}/${regras[i].outputKey} ${r.estourou}` };
    if (r === true) { saida = i; break; } // fallbackOutput: none, primeira que casar
  }
  if (saida === null) return { parou: null, porta: 'nenhuma (fallback none)' };

  const proximo = destino(NO_SWITCH, saida);
  if (proximo !== NO_IF) return { parou: proximo, porta: regras[saida].outputKey };

  const ifNo = no(NO_IF);
  const r = avaliarBloco(ifNo.parameters.conditions, $json);
  if (r && r.estourou) return { estourou: `${NO_IF} ${r.estourou}` };
  return { parou: destino(NO_IF, r ? 0 : 1), porta: regras[saida].outputKey, ramoIf: r ? 'true' : 'false' };
};

/* -------------------------------------------------------------------- payloads */

const PAUSA = 'Resolve Tenant (pausa)';
const CLIENTE = 'Extrair e Filtrar';
const IGNORA = 'Nota Interna (ignora)';

const CASOS = [
  {
    nome: 'celular do dono (WAHA), nota privada com marcador',
    origem: 'payload REAL — execucao de 2026-08-20 10:18:06',
    body: {
      event: 'message_created',
      message_type: 'outgoing',
      private: true,
      sender: { id: 57, type: 'user' },
      content: '*📱 Enviado do WhatsApp*\n\nBom dia',
    },
    espera: PAUSA,
  },
  {
    nome: 'celular do dono, evento message_updated',
    origem: 'derivado do payload real, trocando so o event',
    body: {
      event: 'message_updated',
      message_type: 'outgoing',
      private: true,
      sender: { id: 57, type: 'user' },
      content: '*📱 Enviado do WhatsApp*\n\nBom dia',
    },
    espera: null,
  },
  {
    nome: 'digitada dentro do Chatwoot',
    origem: 'payload REAL — execucao de 2026-08-20 14:37',
    body: {
      event: 'message_created',
      message_type: 'outgoing',
      private: false,
      sender: { id: 65, name: 'Felipe Santos', type: 'user' },
      content: 'teste',
    },
    espera: PAUSA,
  },
  {
    nome: 'mensagem do cliente (incoming)',
    origem: 'derivado: so os campos que o roteador le',
    body: {
      event: 'message_created',
      message_type: 'incoming',
      private: false,
      sender: { id: 91, type: 'contact' },
      content: 'bom dia, voces tem pao de queijo?',
    },
    espera: CLIENTE,
  },
  {
    nome: 'resposta do proprio bot',
    origem: 'derivado: so os campos que o roteador le',
    body: {
      event: 'message_created',
      message_type: 'outgoing',
      private: false,
      sender: { id: 12, type: 'agent_bot' },
      content: 'Oi! Temos sim, sai a R$ 8,00 o pacote.',
    },
    espera: null,
  },
  {
    nome: 'nota privada da Tool - Transferir para Humano',
    origem: 'conteudo do no "Nota Privada no Chatwoot" (codigo versionado)',
    body: {
      event: 'message_created',
      message_type: 'outgoing',
      private: true,
      sender: { id: 12, type: 'agent_bot' },
      content: '🤖 *Resumo do atendimento via bot:*\n\nCliente quer falar sobre entrega.',
    },
    espera: null,
  },
  {
    nome: 'message_created SEM sender no payload',
    origem: 'derivado: o caso que estourava a expressao da ev6',
    body: {
      event: 'message_created',
      message_type: 'outgoing',
      private: false,
      content: 'mensagem sem remetente',
    },
    espera: null,
  },
];

/* ----------------------------------------------------------------------- corrida */

let falhas = 0;
const linha = (ok, txt) => {
  if (!ok) falhas++;
  console.log(`  ${ok ? 'OK   ' : 'FALHA'} ${txt}`);
};

const rodar = (wf, casos, { silencioso = false } = {}) => {
  const saidas = [];
  for (const c of casos) {
    let r;
    try {
      r = rotear(wf, c.body);
    } catch (e) {
      // Rejeicao inesperada vira FALHA, nao crash: um `throw` aqui derrubaria
      // as assercoes seguintes e esconderia qual propriedade quebrou.
      r = { erro: e.message };
    }
    saidas.push(r);
    if (silencioso) continue;
    if (r.erro) { linha(false, `${c.nome} — erro no simulador: ${r.erro}`); continue; }
    if (r.estourou) { linha(false, `${c.nome} — a expressao ESTOUROU: ${r.estourou}`); continue; }
    const alvo = r.parou;
    const ok = alvo === c.espera;
    const desc = alvo === null ? 'nao roteou' : alvo;
    linha(ok, `${c.nome}  ->  ${desc}${ok ? '' : `  (esperado: ${c.espera ?? 'nao rotear'})`}`);
  }
  return saidas;
};

const md5 = (o) => crypto.createHash('md5').update(JSON.stringify(o)).digest('hex').slice(0, 8);

console.log(`\n== Roteamento da pausa — ${path.relative(RAIZ, ARQ)} ==\n`);

if (!fs.existsSync(ARQ)) {
  console.error(`\n  ERRO: ${ARQ} nao existe. Gere com:\n` +
    `  node scripts/aplicar-conserto-pausa.mjs --export <export.json>\n`);
  process.exit(1);
}

const bruto = fs.readFileSync(ARQ, 'utf8');
const wf = JSON.parse(bruto);
console.log(`  arquivo md5 ${md5(wf)} — ${wf.nodes.length} nos\n`);
rodar(wf, CASOS);

/* --------------------------------------------------------------------- sabotagem */

/*
 * "Teste que nao consegue falhar e pior que teste ausente." Duas sabotagens,
 * cada uma mirando UMA assercao — e as duas conferem que a mutacao ENTROU antes
 * de acreditar no resultado, porque sabotagem que nao muda nada ja passou por
 * verde neste repo.
 */
console.log('\n  -- sabotagem 1: reintroduzir a ev7 (private = false) na saida humano --\n');
{
  const s = JSON.parse(bruto);
  const humano = s.nodes.find((n) => n.name === NO_SWITCH).parameters.rules.values
    .find((r) => r.outputKey === 'humano');
  humano.conditions.conditions.push({
    id: 'ev7',
    leftValue: '={{ $json.body.private }}',
    rightValue: false,
    operator: { type: 'boolean', operation: 'false', singleValue: true },
  });

  const entrou = humano.conditions.conditions.some((c) => c.id === 'ev7') && md5(s) !== md5(wf);
  linha(entrou, `mutacao entrou (md5 ${md5(wf)} -> ${md5(s)}, ids ${humano.conditions.conditions.map((c) => c.id).join(',')})`);

  const [celular] = rodar(s, [CASOS[0]], { silencioso: true });
  linha(
    celular.parou !== PAUSA,
    `com a ev7 de volta, o celular do dono deixa de pausar (foi para: ${celular.parou ?? 'nao roteou'})`,
  );
}

console.log('\n  -- sabotagem 2: remover a condicao private=false do IF --\n');
{
  const s = JSON.parse(bruto);
  const ifNo = s.nodes.find((n) => n.name === NO_IF);
  const antes = ifNo.parameters.conditions.conditions.length;
  ifNo.parameters.conditions.conditions = ifNo.parameters.conditions.conditions
    .filter((c) => c.operator.type !== 'boolean');
  const entrou = ifNo.parameters.conditions.conditions.length === antes - 1 && md5(s) !== md5(wf);
  linha(entrou, `mutacao entrou (${antes} -> ${ifNo.parameters.conditions.conditions.length} condicoes, md5 ${md5(s)})`);

  const [digitada] = rodar(s, [CASOS[2]], { silencioso: true });
  linha(
    digitada.parou !== PAUSA,
    `sem ela, a mensagem digitada no Chatwoot deixa de pausar (foi para: ${digitada.parou ?? 'nao roteou'})`,
  );
}

/* ------------------------------------------------------------------ propriedades */

console.log('\n  -- propriedades do arquivo --\n');
{
  const ifNo = wf.nodes.find((n) => n.name === NO_IF);
  const conexoes = wf.connections[NO_IF]?.main ?? [];
  linha(conexoes.length === 2 && conexoes[1]?.[0]?.node === IGNORA,
    `a saida FALSA do "${NO_IF}" tem destino (${conexoes[1]?.[0]?.node ?? 'NENHUM'})`);
  linha(!bruto.includes('E Humano ou Dispositivo?'),
    'nenhuma referencia sobrou ao nome antigo do no');
  linha(!!ifNo?.notes && !!wf.nodes.find((n) => n.name === NO_SWITCH)?.notes,
    'os dois nos carregam a nota que explica a regra');
  const cliente = wf.nodes.find((n) => n.name === NO_SWITCH).parameters.rules.values
    .find((r) => r.outputKey === 'cliente');
  linha(cliente.conditions.conditions.some((c) => c.id === 'ev3'),
    'a ev3 da saida cliente continua la (nota privada nao acorda o bot)');
}

console.log(`\n${falhas === 0 ? '  Tudo certo.' : `  ${falhas} falha(s).`}\n`);
process.exit(falhas === 0 ? 0 : 1);
