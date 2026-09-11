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
  ACOES, NOMES_ACOES, NO_PRINCIPAL, descricaoFerramenta, dicaFromAI, secaoPrompt, textoAcaoInvalida,
} from '../n8n/tool-pedido-acoes.mjs';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = JSON.parse(fs.readFileSync(path.join(RAIZ, 'n8n', 'workflows', 'tool-gerenciar-pedido.json'), 'utf8'));
const PRINCIPAL = JSON.parse(fs.readFileSync(path.join(RAIZ, 'n8n', 'workflows', 'agente-principal.json'), 'utf8'));
const md5 = (t) => crypto.createHash('md5').update(typeof t === 'string' ? t : JSON.stringify(t), 'utf8').digest('hex').slice(0, 12);

let ok = 0;
const falhas = [];
const chk = (nome, cond, det = '') => {
  if (cond) { ok++; console.log(`  OK    ${nome}`); }
  else { falhas.push(nome); console.log(`  FALHA ${nome}${det ? ` — ${det}` : ''}`); }
};

const no = (w, nome) => w.nodes.find((n) => n.name === nome);
const TRG = 'When Executed by Another Workflow';

/** Os campos que o `queryReplacement` de um nó lê, na ordem de `$1..$n`. */
function paramsDoNo(n) {
  const qr = String(n.parameters?.options?.queryReplacement ?? '');
  return [...qr.matchAll(/\$\('When Executed by Another Workflow'\)\.item\.json\.(\w+)/g)].map((m) => m[1]);
}

/** Alcança `alvo` a partir de `origem`, pelo grafo real. */
function alcanca(w, origem, alvo, vistos = new Set()) {
  if (origem === alvo) return true;
  if (vistos.has(origem)) return false;
  vistos.add(origem);
  return (w.connections[origem]?.main ?? []).flat().some((c) => c && alcanca(w, c.node, alvo, vistos));
}

// ===========================================================================
console.log('\n== 1. Uma fonte, quatro derivados — e eles batem ==\n');
// ===========================================================================
{
  const sw = no(TOOL, 'Qual Acao?');
  const chaves = sw.parameters.rules.values.map((r) => r.outputKey);
  chk('as saídas do switch são EXATAMENTE as ações da fonte, na ordem',
    JSON.stringify(chaves) === JSON.stringify(NOMES_ACOES), chaves.join(','));
  chk('o fallback é a última saída (a inválida)',
    sw.parameters.options.fallbackOutput === NOMES_ACOES.length);
  chk('cada regra compara `acao` sem diferenciar maiúsculas (o modelo escreve "Fechar")',
    sw.parameters.rules.values.every((r) => r.conditions.options.caseSensitive === false));

  for (const a of ACOES) {
    const n = no(TOOL, a.no);
    chk(`ação ${a.acao}: existe o nó "${a.no}" e ele chama ${a.funcao}`,
      Boolean(n) && n.parameters.query.includes(`public.${a.funcao}(`));
    chk(`  ...e o queryReplacement lê ${a.params.join(', ')}`,
      JSON.stringify(paramsDoNo(n)) === JSON.stringify(a.params), paramsDoNo(n).join(','));
  }

  const g = no(PRINCIPAL, NO_PRINCIPAL);
  chk('o principal tem o nó "Gerenciar Pedido"', Boolean(g));
  chk('a `description` do principal == descricaoFerramenta() (derivada, não órfã)',
    g?.parameters?.description === descricaoFerramenta(),
    `${md5(g?.parameters?.description ?? '')} vs ${md5(descricaoFerramenta())}`);
  chk('e a dica do $fromAI(acao) lista as cinco ações',
    String(g?.parameters?.workflowInputs?.value?.acao ?? '').includes(dicaFromAI()));
  chk('e nenhum nó "Fechar Pedido" / "Cancelar Pedido" sobrou no principal',
    !no(PRINCIPAL, 'Fechar Pedido') && !no(PRINCIPAL, 'Cancelar Pedido'));

  const ligadas = Object.entries(PRINCIPAL.connections)
    .filter(([, v]) => (v.ai_tool ?? []).flat().some((d) => d?.node === 'AI Agent Vendas'))
    .map(([k]) => k).sort();
  chk('o AI Agent Vendas tem 6 tools ligadas (8 − 2 fundidas), não 5 nem 8',
    ligadas.length === 6 && ligadas.includes(NO_PRINCIPAL), `${ligadas.length}: ${ligadas.join(', ')}`);

  const sm = no(PRINCIPAL, 'AI Agent Vendas').parameters.options.systemMessage;
  const i = sm.indexOf('## Ferramenta: gerenciar_pedido');
  const fim = sm.indexOf('\n## ', i + 1);
  const secao = sm.slice(i, fim).trim();
  chk('a seção do system message == secaoPrompt() (derivada)',
    secao === secaoPrompt().trim(), `${md5(secao)} vs ${md5(secaoPrompt().trim())}`);
  chk('e as seções de fechar_pedido e cancelar_pedido SUMIRAM do system message',
    !sm.includes('## Ferramenta: fechar_pedido') && !sm.includes('## Ferramenta: cancelar_pedido'));
  chk('o AI Agent Basico continua sem seção de venda nenhuma',
    !no(PRINCIPAL, 'AI Agent Basico').parameters.options.systemMessage.includes('gerenciar_pedido'));

  chk('o texto de "Acao Invalida" == textoAcaoInvalida()',
    no(TOOL, 'Acao Invalida').parameters.assignments.assignments[0].value === '=' + textoAcaoInvalida());
}

// ===========================================================================
console.log('\n== 2. Estrutura: tool_ativa primeiro, toda ação termina em Retorno ==\n');
// ===========================================================================
{
  const cfg = no(TOOL, 'Busca Config');
  chk('`Busca Config` consulta api_n8n_config_tool para "vendas" — a UMA linha do catálogo',
    /api_n8n_config_tool\(\$1::uuid, 'vendas'\)/.test(cfg.parameters.query));
  chk('o trigger vai DIRETO para Busca Config (tool_ativa é a primeira coisa)',
    TOOL.connections[TRG].main[0][0].node === 'Busca Config');
  chk('e nenhum nó Postgres de ação é alcançável sem passar por "Vendas Ativa?"',
    ACOES.every((a) => !alcanca({ ...TOOL, connections: { ...TOOL.connections, 'Vendas Ativa?': { main: [] } } }, TRG, a.no)));
  chk('a saída "não" de Vendas Ativa? vai para Vendas Indisponivel, que existe',
    TOOL.connections['Vendas Ativa?'].main[1][0].node === 'Vendas Indisponivel' && Boolean(no(TOOL, 'Vendas Indisponivel')));

  for (const a of ACOES) {
    chk(`ação ${a.acao} chega ao Retorno`, alcanca(TOOL, a.no, 'Retorno'));
  }
  chk('Acao Invalida chega ao Retorno', alcanca(TOOL, 'Acao Invalida', 'Retorno'));

  // O ramo `fechar` passa pela notificação ao dono, e os dois flags que impedem
  // WAHA fora do ar de derrubar um fechamento já feito continuam lá.
  const fechar = ACOES.find((a) => a.notificaVenda);
  chk('o ramo fechar passa por "Reivindica Notificacao"', alcanca(TOOL, fechar.no, 'Reivindica Notificacao'));
  const rei = no(TOOL, 'Reivindica Notificacao');
  chk('  ...com alwaysOutputData e onError=continueRegularOutput preservados',
    rei.alwaysOutputData === true && rei.onError === 'continueRegularOutput');
  chk('  ...e WAHA/Confirma também engolem erro (fechamento não depende do aviso)',
    no(TOOL, 'Notifica Venda WAHA').onError === 'continueRegularOutput'
    && no(TOOL, 'Confirma Notificacao').onError === 'continueRegularOutput');
  chk('  ...e o Retorno recebe o resultado do FECHAMENTO, não o da notificação',
    no(TOOL, 'Resultado do Fechamento').parameters.assignments.assignments[0].value
      === `={{ $('${fechar.no}').first().json.resultado }}`);
  chk('as outras quatro ações vão DIRETO ao Retorno',
    ACOES.filter((a) => !a.notificaVenda).every((a) => TOOL.connections[a.no].main[0][0].node === 'Retorno'));

  // Nenhum ramo do switch fica solto.
  const saidas = TOOL.connections['Qual Acao?'].main;
  chk('o switch tem uma saída ligada por ação + a inválida, nenhuma solta',
    saidas.length === NOMES_ACOES.length + 1 && saidas.every((s) => s.length === 1));
}

// ===========================================================================
console.log('\n== 3. O EFEITO no banco, por ação, com a query DO JSON ==\n');
// ===========================================================================
const url = fs.readFileSync(path.join(RAIZ, '.env.local'), 'utf8')
  .split(/\r?\n/).find((l) => l.startsWith('SUPABASE_DB_URL='))
  .slice('SUPABASE_DB_URL='.length).trim().replace(/^["']|["']$/g, '');
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await c.connect();
await c.query('begin');

/** Executa a query de UM nó do JSON com as entradas do trigger. */
async function executar(w, nomeNo, entradas) {
  const n = no(w, nomeNo);
  const params = paramsDoNo(n).map((campo) => entradas[campo] ?? null);
  const r = await c.query(n.parameters.query, params);
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
  const noDe = (acao) => ACOES.find((a) => a.acao === acao).no;

  // --- adicionar ---
  {
    const antes = (await um(`select count(*)::int n from public.pedidos where tenant_id=$1`, [T])).n;
    const r = await executar(TOOL, noDe('adicionar'), { ...base, produto_id: p1, quantidade: 10, observacao: 'bem quentinho' });
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
    await executar(TOOL, noDe('adicionar'), { ...base, produto_id: p1, quantidade: 4, observacao: '' });
    const q = (await um(`select i.quantidade from public.pedido_itens i join public.pedidos p on p.id=i.pedido_id
                          where p.tenant_id=$1 and p.conversation_id=$2 and i.produto_id=$3`, [T, CONV, p1])).quantidade;
    chk('adicionar o mesmo item DEFINE a quantidade (10 -> 4), como a 49 decidiu', q === 4, String(q));
  }
  // --- ver: NÃO altera nada ---
  {
    await executar(TOOL, noDe('adicionar'), { ...base, produto_id: p2, quantidade: 1, observacao: '' });
    const antes = await retrato(T);
    const r = await executar(TOOL, noDe('ver'), base);
    const depois = await retrato(T);
    chk('ver: devolve os dois itens e o total (4×1,50 + 20,00 = 26,00)', /Pão de queijo/.test(r) && /Queijo Coalho/.test(r) && /26,00/.test(r), r);
    chk('ver: o retrato do banco é IDÊNTICO antes e depois', antes === depois, `${antes} vs ${depois}`);
  }
  // --- remover ---
  {
    const r = await executar(TOOL, noDe('remover'), { ...base, produto_id: p2 });
    const resta = (await um(`select count(*)::int n from public.pedido_itens i join public.pedidos p on p.id=i.pedido_id
                              where p.tenant_id=$1 and p.conversation_id=$2`, [T, CONV])).n;
    const total = (await um(`select total_centavos t from public.pedidos where tenant_id=$1 and conversation_id=$2`, [T, CONV])).t;
    chk('remover: o item saiu do banco (2 -> 1) e o total recalculou (600)', resta === 1 && total === 600, `itens=${resta} total=${total}`);
    chk('remover: o texto devolvido já não tem o queijo', !/Queijo Coalho/.test(r), r);
  }
  // --- fechar ---
  let pedidoFechado = null;
  {
    const r = await executar(TOOL, noDe('fechar'), { ...base, metadados: '{"entrega":"retirada"}' });
    pedidoFechado = await um(`select id, status, numero, metadados from public.pedidos where tenant_id=$1 and conversation_id=$2`, [T, CONV]);
    chk('fechar: o status virou aguardando_pagamento', pedidoFechado?.status === 'aguardando_pagamento', pedidoFechado?.status);
    chk('fechar: ganhou número', Number.isInteger(pedidoFechado?.numero) && pedidoFechado.numero > 0, String(pedidoFechado?.numero));
    chk('fechar: os metadados foram gravados', pedidoFechado?.metadados?.entrega === 'retirada', JSON.stringify(pedidoFechado?.metadados));
    chk('fechar: o texto traz o número', new RegExp(`n[ºo°]?\\s*${pedidoFechado?.numero}`).test(r), r);
  }
  // --- TRAVA: fechar de novo ---
  {
    const antes = await retrato(T);
    const r = await executar(TOOL, noDe('fechar'), { ...base, metadados: '' });
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
    const noCancelar = no(TOOL, noDe('cancelar'));
    chk('a query do JSON chama cancelar_pedido com DOIS argumentos (sem p_alvo)',
      /api_n8n_cancelar_pedido\(\$1::uuid, \$2::bigint\)/.test(noCancelar.parameters.query)
      && !/\$3/.test(noCancelar.parameters.query), noCancelar.parameters.query);

    const r = await executar(TOOL, noDe('cancelar'), base);
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
    await executar(TOOL, noDe('adicionar'), { ...base, produto_id: p2, quantidade: 2, observacao: '' });
    const fech = await um(`select status, total_centavos from public.pedidos where id=$1`, [pedidoFechado.id]);
    const n = (await um(`select count(*)::int n from public.pedidos where tenant_id=$1 and conversation_id=$2`, [T, CONV])).n;
    chk('depois de fechado, adicionar NÃO altera a venda (600, aguardando) e abre um rascunho novo (2 pedidos)',
      fech.status === 'aguardando_pagamento' && fech.total_centavos === 600 && n === 2, `n=${n} ${JSON.stringify(fech)}`);
  }
  // --- cancelar o carrinho novo ---
  {
    const r = await executar(TOOL, noDe('cancelar'), base);
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
    const r = await executar(TOOL, noDe('ver'), { tenant_id: TB, conversation_id: CONV });
    chk('isolamento: o tenant B, na MESMA conversation_id, não vê o pedido do A', !/Pão de queijo/.test(r), r);
    const r2 = await executar(TOOL, noDe('remover'), { tenant_id: TB, conversation_id: CONV, produto_id: p1 });
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
// S1 — O CASO 1 DO ENUNCIADO: `fechar` vira apelido de `ver`. O nó responde, a
//      chamada "funciona", e nada fecha. Só a asserção de EFEITO pega.
{
  const sab = JSON.parse(JSON.stringify(TOOL));
  const fech = no(sab, ACOES.find((a) => a.acao === 'fechar').no);
  const ver = no(sab, ACOES.find((a) => a.acao === 'ver').no);
  const antes = md5(fech.parameters);
  fech.parameters = JSON.parse(JSON.stringify(ver.parameters));
  console.log(`     [mutou "fechar = apelido de ver": md5 ${antes} -> ${md5(fech.parameters)}]`);

  await c.query('begin');
  try {
    const T2 = (await um(`insert into public.tenants (slug, nome) values ('z-teste-fusao-s1', 'S1') returning id`)).id;
    await c.query(`insert into public.tenant_tools (tenant_id, tool_nome, ativo, contratado) values ($1, 'vendas', true, true)`, [T2]);
    const p = (await um(`insert into public.produtos (tenant_id, nome, preco_centavos, unidade, disponivel)
                          values ($1, 'X', 500, 'un', true) returning id`, [T2])).id;
    const e = { tenant_id: T2, conversation_id: 770009, produto_id: p, quantidade: 1, observacao: '' };
    await executar(sab, 'Adiciona Item', e);
    const r = await executar(sab, 'Fecha Pedido', { ...e, metadados: '' });
    const st = (await um(`select status from public.pedidos where tenant_id=$1`, [T2])).status;
    chk('S1: a chamada RESPONDE normalmente (o texto parece um pedido)', typeof r === 'string' && /X/.test(r));
    chk('S1: ...e o status NÃO virou aguardando_pagamento — a asserção de efeito pega o apelido',
      st === 'rascunho', st);
  } finally { await c.query('rollback'); }
}

// S2 — tirar `cancelar` do switch: a derivação acusa.
{
  const sab = JSON.parse(JSON.stringify(TOOL));
  const sw = no(sab, 'Qual Acao?');
  const antes = md5(sw.parameters);
  sw.parameters.rules.values = sw.parameters.rules.values.filter((r) => r.outputKey !== 'cancelar');
  console.log(`     [mutou "switch sem cancelar": md5 ${antes} -> ${md5(sw.parameters)}]`);
  const chaves = sw.parameters.rules.values.map((r) => r.outputKey);
  chk('S2: o switch deixa de bater com a fonte',
    JSON.stringify(chaves) !== JSON.stringify(NOMES_ACOES), chaves.join(','));
}

// S3 — description do principal editada na mão (o que a UI faz): a derivação acusa.
{
  const sab = JSON.parse(JSON.stringify(PRINCIPAL));
  const g = no(sab, NO_PRINCIPAL);
  const antes = md5(g.parameters.description);
  g.parameters.description = g.parameters.description.replace('acao=cancelar', 'acao=cancel');
  console.log(`     [mutou "description na mão": md5 ${antes} -> ${md5(g.parameters.description)}]`);
  chk('S3: a description deixa de bater com descricaoFerramenta()',
    g.parameters.description !== descricaoFerramenta());
}

await c.end();
console.log(`\n${'-'.repeat(62)}`);
console.log(`  ${ok} passaram, ${falhas.length} falharam`);
if (falhas.length) { for (const f of falhas) console.log(`    - ${f}`); process.exit(1); }
