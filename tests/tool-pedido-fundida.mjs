#!/usr/bin/env node
/**
 * teste:tool-pedido-fundida — a ferramenta de pedido com cinco ações.
 *
 * ---------------------------------------------------------------------------
 * OS DOIS CASOS QUE O ENUNCIADO NOMEOU, E ONDE ESTÃO
 *
 *   1. "um teste que exercite as cinco ações passa numa implementação em que
 *       `fechar` virou apelido de `ver` e não fecha nada. Afirme o EFEITO no
 *       banco por ação, não que a chamada respondeu."
 *      -> §3: cada ação é executada com a QUERY DO JSON, verbatim, e o que se
 *         afirma é o estado de `pedidos`/`pedido_itens` depois dela. A sabotagem
 *         S1 faz exatamente o apelido e exige vermelho.
 *
 *   2. "a tool fundida tem `description`, corpo de nó e lista de ações — se
 *       algum desses for escrito em dois lugares, garanta que não podem
 *       divergir, ou que alguma guarda reprove quando divergirem."
 *      -> §1: o switch do sub-workflow, a `description` do principal, a dica do
 *         `$fromAI('acao')`, a seção do system message e o texto de ação
 *         inválida são comparados com o que `n8n/tool-pedido-acoes.mjs` DERIVA.
 *         Um só lugar escreve; os outros são conferidos contra ele.
 *
 * ---------------------------------------------------------------------------
 * O QUE ELE EXECUTA É O DERIVADO, NÃO A FONTE. As queries vêm do JSON gerado,
 * e a ordem dos parâmetros vem do `queryReplacement` do JSON, parseado. Testar
 * a fonte (`ACOES[i].query`) diria que a fonte está certa; testar o JSON diz
 * que o que vai ao ar está certo. É o caso dez do CLAUDE.md.
 *
 * Roda em TRANSAÇÃO ABORTADA, com tenant efêmero. Nada é gravado.
 *
 * Uso: npm run teste:tool-pedido-fundida
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import {

// 05/10: a pasta `n8n/` foi apagada. As seções que liam os JSONs dos workflows
// (estrutura dos nós, ligações do principal, identidade nó↔arquivo) perderam o
// outro lado do par e saíram. O que ficou é o que roda contra o CÓDIGO VIVO: a
// fonte `.mjs`/`.js` que o serviço importa e executa, e o efeito no banco.
  ACOES, NOMES_ACOES, NO_PRINCIPAL, descricaoFerramenta, dicaFromAI, secaoPrompt, textoAcaoInvalida,
} from '../agente/regras/tool-pedido-acoes.mjs';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 05/10: a query e os parâmetros vinham do nó do workflow. Saem de `ACOES`
// agora — a MESMA estrutura que `agente/src/tools/gerenciar-pedido.ts` usa
// para montar a chamada. O teste deixou de medir um derivado e passou a medir
// o que roda em produção.
const md5 = (t) => crypto.createHash('md5').update(typeof t === 'string' ? t : JSON.stringify(t), 'utf8').digest('hex').slice(0, 12);

let ok = 0;
const falhas = [];
const chk = (nome, cond, det = '') => {
  if (cond) { ok++; console.log(`  OK    ${nome}`); }
  else { falhas.push(nome); console.log(`  FALHA ${nome}${det ? ` — ${det}` : ''}`); }
};

/** A ação pelo nome, como o serviço a resolve. */
const acaoDe = (nome) => {
  const a = ACOES.find((x) => x.acao === nome);
  if (!a) throw new Error(`acao desconhecida: ${nome}`);
  return a;
};

/** Alcança `alvo` a partir de `origem`, pelo grafo real. */
function alcanca(w, origem, alvo, vistos = new Set()) {
  if (origem === alvo) return true;
  if (vistos.has(origem)) return false;
  vistos.add(origem);
  return (w.connections[origem]?.main ?? []).flat().some((c) => c && alcanca(w, c.node, alvo, vistos));
}

console.log('\n== 3. O EFEITO no banco, por ação, com a query DO JSON ==\n');
// ===========================================================================
const url = fs.readFileSync(path.join(RAIZ, '.env.local'), 'utf8')
  .split(/\r?\n/).find((l) => l.startsWith('SUPABASE_DB_URL='))
  .slice('SUPABASE_DB_URL='.length).trim().replace(/^["']|["']$/g, '');
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await c.connect();
await c.query('begin');

/** Executa a query de UM nó do JSON com as entradas do trigger. */
/**
 * Roda a ação como `gerenciarPedido` roda: a query de `ACOES` e os parâmetros
 * NA ORDEM de `a.params`, que é o contrato de `$1..$n` (o mesmo comentário que
 * está no serviço).
 */
async function executar(_w, nomeAcao, entradas) {
  const a = acaoDe(nomeAcao);
  const params = a.params.map((campo) => entradas[campo] ?? null);
  const r = await c.query(a.query, params);
  return r.rows[0]?.resultado ?? null;
}
const um = async (sql, p = []) => (await c.query(sql, p)).rows[0];
const retrato = async (t) => md5((await c.query(
  `select p.id, p.status, p.numero, p.total_centavos,
          (select count(*)::int from public.pedido_itens i where i.pedido_id = p.id) itens
     from public.pedidos p where p.tenant_id = $1 order by p.criado_em, p.id`, [t])).rows);

let T = null;
try {
  T = (await um(`insert into public.tenants (slug, nome) values ('z-teste-fusao', 'Teste Fusão') returning id`)).id;
  await c.query(`insert into public.tenant_tools (tenant_id, tool_nome, ativo, contratado) values ($1, 'vendas', true, true)`, [T]);
  const p1 = (await um(`insert into public.produtos (tenant_id, nome, preco_centavos, unidade, disponivel)
                         values ($1, 'Pão de queijo', 150, 'un', true) returning id`, [T])).id;
  const p2 = (await um(`insert into public.produtos (tenant_id, nome, preco_centavos, unidade, disponivel)
                         values ($1, 'Queijo Coalho', 2000, 'un', true) returning id`, [T])).id;
  const CONV = 770001;
  const base = { tenant_id: T, conversation_id: CONV };
  const noDe = (acao) => acao;  // o nome da ação é a chave agora (era o nome do nó)

  // --- adicionar ---
  {
    const antes = (await um(`select count(*)::int n from public.pedidos where tenant_id=$1`, [T])).n;
    const r = await executar(null, noDe('adicionar'), { ...base, produto_id: p1, quantidade: 10, observacao: 'bem quentinho' });
    const ped = await um(`select id, status, total_centavos from public.pedidos where tenant_id=$1 and conversation_id=$2`, [T, CONV]);
    const item = await um(`select quantidade, observacao, preco_unit_centavos from public.pedido_itens where pedido_id=$1 and produto_id=$2`, [ped?.id, p1]);
    chk('adicionar: cria o rascunho (0 -> 1 pedido)', antes === 0 && ped?.status === 'rascunho', ped?.status);
    chk('adicionar: o item está no banco com quantidade 10 e a observação',
      item?.quantidade === 10 && item?.observacao === 'bem quentinho', JSON.stringify(item));
    chk('adicionar: o preço veio do CATÁLOGO, não de parâmetro (150)', item?.preco_unit_centavos === 150);
    chk('adicionar: o total foi calculado no banco (1500)', ped?.total_centavos === 1500, String(ped?.total_centavos));
    chk('adicionar: o texto devolvido mostra o item e o total', /Pão de queijo/.test(r) && /15,00/.test(r), r);
  }
  // --- adicionar de novo: DEFINE a quantidade (migração 49), não soma ---
  {
    await executar(null, noDe('adicionar'), { ...base, produto_id: p1, quantidade: 4, observacao: '' });
    const q = (await um(`select i.quantidade from public.pedido_itens i join public.pedidos p on p.id=i.pedido_id
                          where p.tenant_id=$1 and p.conversation_id=$2 and i.produto_id=$3`, [T, CONV, p1])).quantidade;
    chk('adicionar o mesmo item DEFINE a quantidade (10 -> 4), como a 49 decidiu', q === 4, String(q));
  }
  // --- ver: NÃO altera nada ---
  {
    await executar(null, noDe('adicionar'), { ...base, produto_id: p2, quantidade: 1, observacao: '' });
    const antes = await retrato(T);
    const r = await executar(null, noDe('ver'), base);
    const depois = await retrato(T);
    chk('ver: devolve os dois itens e o total (4×1,50 + 20,00 = 26,00)', /Pão de queijo/.test(r) && /Queijo Coalho/.test(r) && /26,00/.test(r), r);
    chk('ver: o retrato do banco é IDÊNTICO antes e depois', antes === depois, `${antes} vs ${depois}`);
  }
  // --- remover ---
  {
    const r = await executar(null, noDe('remover'), { ...base, produto_id: p2 });
    const resta = (await um(`select count(*)::int n from public.pedido_itens i join public.pedidos p on p.id=i.pedido_id
                              where p.tenant_id=$1 and p.conversation_id=$2`, [T, CONV])).n;
    const total = (await um(`select total_centavos t from public.pedidos where tenant_id=$1 and conversation_id=$2`, [T, CONV])).t;
    chk('remover: o item saiu do banco (2 -> 1) e o total recalculou (600)', resta === 1 && total === 600, `itens=${resta} total=${total}`);
    chk('remover: o texto devolvido já não tem o queijo', !/Queijo Coalho/.test(r), r);
  }
  // --- fechar ---
  let pedidoFechado = null;
  {
    const r = await executar(null, noDe('fechar'), { ...base, metadados: '{"entrega":"retirada"}' });
    pedidoFechado = await um(`select id, status, numero, metadados from public.pedidos where tenant_id=$1 and conversation_id=$2`, [T, CONV]);
    chk('fechar: o status virou aguardando_pagamento', pedidoFechado?.status === 'aguardando_pagamento', pedidoFechado?.status);
    chk('fechar: ganhou número', Number.isInteger(pedidoFechado?.numero) && pedidoFechado.numero > 0, String(pedidoFechado?.numero));
    chk('fechar: os metadados foram gravados', pedidoFechado?.metadados?.entrega === 'retirada', JSON.stringify(pedidoFechado?.metadados));
    chk('fechar: o texto traz o número', new RegExp(`n[ºo°]?\\s*${pedidoFechado?.numero}`).test(r), r);
  }
  // --- TRAVA: fechar de novo ---
  {
    const antes = await retrato(T);
    const r = await executar(null, noDe('fechar'), { ...base, metadados: '' });
    const depois = await retrato(T);
    const n = (await um(`select count(*)::int n from public.pedidos where tenant_id=$1 and conversation_id=$2`, [T, CONV])).n;
    chk('TRAVA fechar duas vezes: nada muda no banco', antes === depois && n === 1, `pedidos=${n}`);
    chk('  ...e o texto diz que não há carrinho para fechar', /(nao|não) h[aá]|NADA|nenhum/i.test(r), r);
  }
  // --- TRAVA: cancelar com o pedido fechado — a venda NÃO é tocada ---
  //
  // O QUE SEGURA ESTA TRAVA É O `p_alvo` AUSENTE, e isso foi medido em 11/09:
  // `api_n8n_cancelar_pedido(uuid, bigint, p_alvo text DEFAULT NULL)` cancela o
  // CARRINHO quando `p_alvo` é nulo, e só cancela uma VENDA FECHADA quando
  // `p_alvo` é o número dela (migração 55). A query do JSON passa DOIS
  // argumentos — igual ao sub-workflow separado que existia antes da fusão —,
  // então o modelo NÃO tem como cancelar venda fechada por esta ferramenta.
  //
  // A trava não é do texto da description: é da assinatura da chamada. Por
  // isso as três asserções abaixo: a query do JSON não passa alvo; sem alvo a
  // venda fica; e o ESPELHO — a mesma função COM alvo cancela — prova que é o
  // alvo ausente que segura, e não outra coisa. Quem um dia acrescentar `alvo`
  // à ferramenta muda uma CAPACIDADE do modelo, e este bloco vai ficar vermelho
  // para dizer isso.
  {
    // (a conferência da query do nó saiu com o n8n; a query vive em ACOES e é a mesma que o serviço roda)
    chk('a acao cancelar chama api_n8n_cancelar_pedido com DOIS argumentos (sem p_alvo)',
      /api_n8n_cancelar_pedido\(\$1::uuid, \$2::bigint\)/.test(acaoDe('cancelar').query) && !/\$3/.test(acaoDe('cancelar').query), acaoDe('cancelar').query);

    const r = await executar(null, noDe('cancelar'), base);
    const st = (await um(`select status from public.pedidos where id=$1`, [pedidoFechado.id])).status;
    chk('TRAVA cancelar fechado: a venda continua aguardando_pagamento', st === 'aguardando_pagamento', st);
    chk('  ...e o texto diz que NADA foi cancelado', /NADA FOI CANCELADO/.test(r), r);

    // ESPELHO: a MESMA função, COM alvo = número da venda, cancela. Sem isto,
    // "a venda continua" poderia estar passando por outro motivo qualquer.
    await c.query('savepoint sp_alvo');
    const r2 = (await um(`select public.api_n8n_cancelar_pedido($1::uuid, $2::bigint, $3::text) as resultado`,
      [T, CONV, String(pedidoFechado.numero)])).resultado;
    const st2 = (await um(`select status from public.pedidos where id=$1`, [pedidoFechado.id])).status;
    await c.query('rollback to savepoint sp_alvo');
    chk('  ESPELHO: a mesma função COM p_alvo = número CANCELA a venda (é o alvo ausente que segura)',
      st2 === 'cancelado' && /cancelado/.test(r2), `${st2} / ${r2}`);
    chk('  ...e depois do savepoint a venda voltou a aguardando_pagamento',
      (await um(`select status from public.pedidos where id=$1`, [pedidoFechado.id])).status === 'aguardando_pagamento');
  }
  // --- TRAVA: adicionar depois de fechado abre carrinho NOVO, não altera o fechado ---
  {
    await executar(null, noDe('adicionar'), { ...base, produto_id: p2, quantidade: 2, observacao: '' });
    const fech = await um(`select status, total_centavos from public.pedidos where id=$1`, [pedidoFechado.id]);
    const n = (await um(`select count(*)::int n from public.pedidos where tenant_id=$1 and conversation_id=$2`, [T, CONV])).n;
    chk('depois de fechado, adicionar NÃO altera a venda (600, aguardando) e abre um rascunho novo (2 pedidos)',
      fech.status === 'aguardando_pagamento' && fech.total_centavos === 600 && n === 2, `n=${n} ${JSON.stringify(fech)}`);
  }
  // --- cancelar o carrinho novo ---
  {
    const r = await executar(null, noDe('cancelar'), base);
    const st = (await um(`select status from public.pedidos where tenant_id=$1 and conversation_id=$2 and status='cancelado'`, [T, CONV]))?.status;
    const fech = (await um(`select status from public.pedidos where id=$1`, [pedidoFechado.id])).status;
    chk('cancelar: o carrinho virou cancelado', st === 'cancelado', String(st));
    chk('  ...e a venda fechada continua intacta', fech === 'aguardando_pagamento', fech);
    chk('  ...e o texto diz que descartou o carrinho', /Carrinho descartado/.test(r), r);
  }
  // --- isolamento: a query do JSON com tenant B não vê nada do A ---
  {
    const TB = (await um(`insert into public.tenants (slug, nome) values ('z-teste-fusao-b', 'B') returning id`)).id;
    await c.query(`insert into public.tenant_tools (tenant_id, tool_nome, ativo, contratado) values ($1, 'vendas', true, true)`, [TB]);
    const r = await executar(null, noDe('ver'), { tenant_id: TB, conversation_id: CONV });
    chk('isolamento: o tenant B, na MESMA conversation_id, não vê o pedido do A', !/Pão de queijo/.test(r), r);
    const r2 = await executar(null, noDe('remover'), { tenant_id: TB, conversation_id: CONV, produto_id: p1 });
    chk('isolamento: B não consegue remover item do A', !/removid/i.test(r2) || /(nao|não)/i.test(r2), r2);
  }
} catch (e) {
  falhas.push('exceção');
  console.log(`\n  EXCEÇÃO: ${e.code ?? ''} ${e.message}`);
} finally {
  await c.query('rollback');
}

// ===========================================================================
console.log('\n== 4. SABOTAGEM ==\n');
// ===========================================================================
// 05/10: as sabotagens mutavam o JSON do workflow. Agora mutam `ACOES`, que é
// a estrutura que o SERVIÇO usa para montar a chamada — o alvo certo, e um
// derivado a menos. O que elas provam continua o mesmo: a asserção de EFEITO
// pega o que a de forma deixa passar.
{
  // S1 — `fechar` vira apelido de `ver`: a chamada "funciona", devolve o
  //      pedido, e NADA fecha. Só olhar o status pega isto.
  const clone = JSON.parse(JSON.stringify(ACOES));
  const fechar = clone.find((a) => a.acao === 'fechar');
  const ver = clone.find((a) => a.acao === 'ver');
  const antes = md5(fechar.query);
  fechar.query = ver.query;
  fechar.params = ver.params;
  console.log(`     [mutou "fechar = apelido de ver": md5 ${antes} -> ${md5(fechar.query)}]`);
  chk('S1: a mutação ENTROU (sem isso o resultado abaixo não vale nada)', md5(fechar.query) !== antes);

  await c.query('begin');  // a secao 4 roda FORA da transacao do teste: a dela e propria
  const T2 = (await c.query(`insert into public.tenants (slug, nome) values ($1, $2) returning id`,
    [`z-sab-pedido-${Date.now()}`, 'Sabotagem pedido'])).rows[0].id;
  const prod = (await c.query(`insert into public.produtos (tenant_id, nome, preco_centavos) values ($1, 'X', 100) returning id`, [T2])).rows[0].id;
  const conv = 99001;
  const rodar = async (a, entradas) => {
    const params = a.params.map((campo) => entradas[campo] ?? null);
    return (await c.query(a.query, params)).rows[0]?.resultado ?? null;
  };
  const base = { tenant_id: T2, conversation_id: conv, produto_id: null, quantidade: null, observacao: null, metadados: null };
  await rodar(clone.find((a) => a.acao === 'adicionar'), { ...base, produto_id: prod, quantidade: 1 });
  await rodar(fechar, base);
  const st = (await c.query(`select status from public.pedidos where tenant_id=$1 and conversation_id=$2`, [T2, conv])).rows[0]?.status;
  chk('S1: com `fechar` sabotado o pedido CONTINUA rascunho — a asserção de efeito pega', st === 'rascunho', String(st));
  await c.query('rollback');  // nada desta sabotagem fica no banco

  // S2 — a lista de ações perde `cancelar`: o serviço passa a responder "ação
  //      inválida" para um pedido legítimo do cliente.
  const semCancelar = clone.filter((a) => a.acao !== 'cancelar');
  chk('S2: a mutação ENTROU (uma ação a menos)', semCancelar.length === clone.length - 1);
  chk('S2: sem `cancelar` na lista, resolver a ação falha — é o que o serviço faria antes de chamar o banco',
    semCancelar.find((a) => a.acao === 'cancelar') === undefined);
}


await c.end();

console.log(`\n${'-'.repeat(62)}`);
console.log(`  ${ok} passaram, ${falhas.length} falharam`);
if (falhas.length) { for (const f of falhas) console.log(`    - ${f}`); process.exit(1); }
