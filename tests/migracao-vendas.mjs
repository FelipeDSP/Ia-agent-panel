#!/usr/bin/env node
/**
 * Migracoes 25 (pedidos) e 26 (funcoes de venda) — validacao do par completo.
 *
 * Aplica as duas migracoes, exercita as sete funcoes e roda os dois rollbacks,
 * TUDO dentro de uma transacao que termina em ROLLBACK. Nada e persistido: da
 * para rodar contra producao sem medo, e foi assim que este par foi validado
 * antes de ser aplicado.
 *
 * Roda com a conexao direta (SUPABASE_DB_URL), como postgres. Por isso ele NAO
 * substitui tests/isolamento-pedidos.mjs, que usa JWT de usuario real: rodar
 * como postgres passa por cima da RLS e passaria enganosamente. O que se prova
 * aqui e a logica das funcoes — travas de preco, snapshot, status, unicidade —
 * e o isolamento que vem do filtro por p_tenant_id dentro delas.
 *
 * ESCOPO POR CONVERSA. As consultas de inspecao filtram por `conversation_id`
 * alem de `tenant_id`. Sem isso o teste enxerga pedido REAL do restaurante-teste
 * — houve uma venda de verdade nele em 11/08/2026 — e compara os numeros dele
 * com os esperados do teste. Doze assercoes quebraram assim. `numero` tambem e
 * sequencial por tenant, entao o pedido do teste nao e mais o de numero 1.
 *
 *
 * Uso: node tests/migracao-vendas.mjs
 */

import fs from 'node:fs';
import pg from 'pg';
import { fileURLToPath } from 'node:url';

const RAIZ = fileURLToPath(new URL('../', import.meta.url));
const conn = fs.readFileSync(RAIZ+'.env.local', 'utf8').match(/SUPABASE_DB_URL=(.*)/)[1].trim();
const c = new pg.Client({ connectionString: conn, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 20000 });
const mig = (f) => fs.readFileSync(RAIZ+'supabase/migrations/' + f, 'utf8').replace(/^\s*(begin|commit)\s*;\s*$/gim, '');
const M25 = mig('20260811185334_25_pedidos.sql');
const M26 = mig('20260811185432_26_api_n8n_vendas.sql');
// A 41 e aplicada em seguida a 26 porque REDEFINE buscar_produtos. Replay de
// um elo so ressuscitaria a assinatura antiga -- a armadilha da 32/37.
const M41 = mig('20260817120000_41_buscar_produtos_total.sql');

/*
 * A CADEIA de `api_n8n_adicionar_item` e 26 -> 38 -> 49, e ate 21/08 este teste
 * PULAVA A 38: aplicava 25 -> 26 -> 41 e exercitava um corpo que a producao ja
 * nao rodava havia uma semana (a 38 acrescentou `expirar_pedidos_vencidos` e
 * redefiniu `pedido_aberto_da_conversa` e `api_n8n_tem_pedido_pendente`).
 *
 * E a mesma armadilha que deixou `tests/migracao-audio.mjs` tres dias vermelho,
 * com a diferenca de que aqui ela custava VERDE: o teste passava sobre uma
 * funcao que ninguem chama. CLAUDE.md ja tinha a regra — "se o teste replaya
 * migracao, replaye a CADEIA, na ordem em que producao a viu".
 *
 * A busca por quem redefine e mecanica, nao de memoria:
 *   grep -l "function public.api_n8n_adicionar_item" supabase/migrations/*.sql
 */
const M38 = mig('20260814160000_38_expirar_pedido_nao_pago.sql');
const M49 = mig('20260821191500_49_adicionar_item_define.sql');
const R49 = mig('20260821191500_49_adicionar_item_define_rollback.sql');
const R55 = mig('20260831093000_55_pedido_novo_apos_fechar_rollback.sql');
const R25 = mig('20260811185334_25_pedidos_rollback.sql');
const R26 = mig('20260811185432_26_api_n8n_vendas_rollback.sql');

const A = 'ebef4715-1a05-41d0-ad62-929b7fefa887'; // Restaurante Teste (13 produtos)
const B = '7cd0750e-e610-497a-bc0e-c1cd83b159ec'; // Sandbox de Testes (6 produtos)
const CONV_A = 900001n, CONV_B = 900002n;

let ok = 0; const falhas = [];
const chk = (nome, cond, det = '') => {
  if (cond) { ok++; console.log(`  OK    ${nome}`); }
  else { falhas.push(`${nome}${det ? ' — ' + det : ''}`); console.log(`  FALHA ${nome}${det ? ' — ' + det : ''}`); }
};
const val = async (sql, p = []) => (await c.query(sql, p)).rows[0]?.[Object.keys((await c.query(sql, p)).rows[0] ?? { x: 1 })[0]];
const um = async (sql, p = []) => { const r = await c.query(sql, p); return r.rows[0]; };

await c.connect();
await c.query('begin');
try {
  /*
   * O DROP ANTES DA 26 nao e zelo: sem ele o replay quebra assim que a 41 entra
   * em producao. A 26 cria buscar_produtos com `create or replace` e o tipo de
   * retorno ANTIGO; contra um banco onde a 41 ja mudou o retorno, o Postgres
   * recusa com "cannot change return type of existing function".
   *
   * Mesma classe do que aconteceu em migracao-audio: replay de um elo contra um
   * banco que ja viu o elo seguinte. O que se replaya e a CADEIA, e a cadeia
   * comeca do estado que um ambiente novo teria -- sem a funcao.
   */
  await c.query('drop function if exists public.api_n8n_buscar_produtos(uuid, text)');

  /*
   * E o mesmo vale do outro lado da cadeia. A 55 trocou
   * `api_n8n_cancelar_pedido(uuid, bigint)` por `(uuid, bigint, text)`:
   * replayar a 26 por cima recria a de 2 argumentos AO LADO da de 3, e a
   * chamada de 2 vira AMBIGUA -- `function api_n8n_cancelar_pedido(unknown,
   * unknown) is not unique`, que e a familia 28/32/37 do CLAUDE.md aparecendo
   * por replay em vez de por migracao.
   *
   * O rollback da 55 desfaz isso e e idempotente, entao vale tendo a 55 subido
   * ou nao -- o teste nao afirma o calendario.
   */
  await c.query(R55);
  // Ordem em que producao viu: 25, 26, 38, 41, 49.
  await c.query(M25); await c.query(M26); await c.query(M38); await c.query(M41);

  /*
   * O ACL de `api_n8n_adicionar_item` e fotografado ANTES da 49 e comparado
   * CONSIGO MESMO depois — nao contra uma lista escrita a mao, que foi como a
   * migracao 41 passou verde sem `n8n_agent` e derrubou o catalogo do emporio.
   * A 49 nao tem `drop function` (assinatura identica), entao a afirmacao a
   * provar e "nada mudou".
   */
  const aclAdicionar = async () => {
    const r = await um(`select coalesce(p.proacl::text[], array[]::text[]) a
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname='public' and p.proname='api_n8n_adicionar_item'`);
    return (r?.a ?? []).map((e) => (e.split('=')[0] === '' ? 'PUBLIC' : e.split('=')[0])).sort().join(',');
  };
  const aclAntes49 = await aclAdicionar();

  await c.query(M49);
  console.log('migracoes 25 e 26 aplicadas\n');

  // produtos reais do catalogo cadastrado na fatia 1
  // Mesma regra de visibilidade das funcoes: senao o teste escolhe um item que
  // a propria funcao recusa de proposito (a agua esta com estoque 0).
  const prods = (await c.query(
    `select id, nome, preco_centavos from public.produtos
      where tenant_id=$1 and deletado_em is null and disponivel
        and (estoque is null or estoque > 0)
      order by nome limit 4`, [A])).rows;
  const pA1 = prods[0], pA2 = prods[1];
  const pB = (await c.query(
    `select id, nome from public.produtos where tenant_id=$1 and deletado_em is null limit 1`, [B])).rows[0];
  console.log(`  catalogo A: ${prods.length} itens | usando "${pA1.nome}" e "${pA2.nome}"`);
  console.log(`  catalogo B: "${pB.nome}"\n`);

  console.log('--- formatacao de dinheiro ---');
  for (const [cent, esp] of [[2490, 'R$ 24,90'], [5, 'R$ 0,05'], [123456, 'R$ 1.234,56'], [100000000, 'R$ 1.000.000,00'], [0, 'R$ 0,00']]) {
    const r = await um('select public.centavos_brl($1) v', [cent]);
    chk(`${cent} -> ${esp}`, r.v === esp, `veio ${r.v}`);
  }

  console.log('\n--- carrinho vazio / sem pedido ---');
  chk('ver_pedido sem pedido', (await um('select public.api_n8n_ver_pedido($1,$2) v', [A, CONV_A])).v.includes('Nao ha pedido aberto'));
  chk('tem_pedido_pendente = false', (await um('select public.api_n8n_tem_pedido_pendente($1,$2) v', [A, CONV_A])).v === false);

  console.log('\n--- adicionar_item: preco vem do CATALOGO, nao do parametro ---');
  let r = await um('select public.api_n8n_adicionar_item($1,$2,$3,$4) v', [A, CONV_A, pA1.id, 2]);
  chk('adiciona e devolve o carrinho inteiro', r.v.includes('Pedido atual') && r.v.includes(pA1.nome), r.v.slice(0, 60));
  const item = await um(`select i.preco_unit_centavos, i.quantidade, i.nome_snapshot from public.pedido_itens i
                         join public.pedidos p on p.id=i.pedido_id where p.tenant_id=$1 and p.conversation_id=$2`, [A, CONV_A]);
  chk('preco gravado = preco do catalogo', item.preco_unit_centavos === pA1.preco_centavos,
      `item=${item.preco_unit_centavos} catalogo=${pA1.preco_centavos}`);
  chk('snapshot do nome congelado', item.nome_snapshot === pA1.nome);
  const ped = await um(`select total_centavos, status, numero from public.pedidos where tenant_id=$1 and conversation_id=$2`, [A, CONV_A]);
  chk('total recalculado pelo trigger', ped.total_centavos === pA1.preco_centavos * 2, `total=${ped.total_centavos}`);
  chk('status inicial rascunho', ped.status === 'rascunho');
  chk('numero ainda nulo antes de fechar', ped.numero === null);

  /*
   * ------------------------------------------------------------------------
   * MIGRACAO 49: DEFINE, nao soma. A INVERSAO E DELIBERADA.
   * ------------------------------------------------------------------------
   * Ate 21/08 este bloco afirmava o CONTRARIO — "dois adicionar_item do mesmo
   * produto SOMAM", com `q === 5`. Somar era decisao de desenho e estava
   * TESTADA; nao foi defeito que passou despercebido.
   *
   * O que mudou nao foi a opiniao sobre somar: foi a descoberta de que o
   * RE-ENVIO acontece. Em 20/08 o modelo inventou uma falha que nao houve,
   * re-adicionou dois itens no turno seguinte, e a soma DOBROU um pedido real —
   * o cliente pediu R$ 45,00 e o pedido fechou em R$ 75,00, em
   * `aguardando_pagamento`, com um texto que nao permitia notar. Ver
   * docs/PENDENCIA-CARRINHO-MULTI-ITEM.md.
   *
   * Somar faz re-envio DOBRAR; definir faz re-envio virar NO-OP.
   *
   * NAO "CONSERTE" ISTO DE VOLTA. Se voce chegou aqui porque uma quantidade
   * caiu quando devia subir, esse e o custo ACEITO: a falha barulhenta (o
   * carrinho volta menor e o cliente ve) no lugar da silenciosa (o pedido dobra
   * e ninguem ve). O conserto certo e o modelo mandar o total novo, nao a
   * funcao voltar a somar.
   */
  console.log('\n--- migracao 49: adicionar_item DEFINE a quantidade ---');
  await c.query('select public.api_n8n_adicionar_item($1,$2,$3,$4)', [A, CONV_A, pA1.id, 3]);
  const linhas = await um(`select count(*)::int n, max(quantidade) q from public.pedido_itens i
                           join public.pedidos p on p.id=i.pedido_id where p.tenant_id=$1 and p.conversation_id=$2`, [A, CONV_A]);
  chk('uma linha so, quantidade DEFINIDA pela ultima chamada (2 -> 3, nao 5)',
      linhas.n === 1 && linhas.q === 3, `linhas=${linhas.n} qtd=${linhas.q}`);

  // A PROPRIEDADE NOVA, e a razao de a mudanca existir. Sem ela o teste so
  // registraria que o numero mudou de 5 para 3.
  await c.query('select public.api_n8n_adicionar_item($1,$2,$3,$4)', [A, CONV_A, pA1.id, 3]);
  const idem = await um(`select count(*)::int n, max(quantidade) q from public.pedido_itens i
                         join public.pedidos p on p.id=i.pedido_id where p.tenant_id=$1 and p.conversation_id=$2`, [A, CONV_A]);
  chk('IDEMPOTENTE: a mesma chamada repetida nao muda nada (3 -> 3)',
      idem.n === 1 && idem.q === 3, `linhas=${idem.n} qtd=${idem.q}`);
  const totIdem = await um(`select total_centavos t from public.pedidos where tenant_id=$1 and conversation_id=$2`, [A, CONV_A]);
  chk('e o total acompanha a quantidade definida', totIdem.t === pA1.preco_centavos * 3, `total=${totIdem.t}`);

  // A ASSIMETRIA DELIBERADA: quantidade e declarativa, observacao e preservada.
  // Sob `definir`, toda correcao de quantidade re-envia a linha — se a
  // observacao tambem fosse definida, um "na verdade sao 5" apagaria o
  // "sem cebola" do cliente. Testado para ninguem "consertar" a assimetria.
  await c.query('select public.api_n8n_adicionar_item($1,$2,$3,$4,$5)', [A, CONV_A, pA1.id, 4, 'sem cebola']);
  await c.query('select public.api_n8n_adicionar_item($1,$2,$3,$4)', [A, CONV_A, pA1.id, 5]);
  const obs = await um(`select quantidade q, observacao o from public.pedido_itens i
                        join public.pedidos p on p.id=i.pedido_id where p.tenant_id=$1 and p.conversation_id=$2`, [A, CONV_A]);
  chk('quantidade DEFINE mas observacao PRESERVA quando a nova e nula',
      obs.q === 5 && obs.o === 'sem cebola', `qtd=${obs.q} obs=${JSON.stringify(obs.o)}`);

  // --- a 49 nao mexe em assinatura nem em grant ---
  const aclDepois49 = await aclAdicionar();
  chk('ACL de adicionar_item IDENTICO antes x depois da 49 (sem drop, nada a reconceder)',
      aclAntes49 === aclDepois49, `antes=${aclAntes49} depois=${aclDepois49}`);
  chk('`n8n_agent` continua no ACL', aclDepois49.includes('n8n_agent'), aclDepois49);
  const assinaturas = (await c.query(`select p.pronargs::int n from pg_proc p
      join pg_namespace ns on ns.oid=p.pronamespace
     where ns.nspname='public' and p.proname='api_n8n_adicionar_item'`)).rows;
  chk('existe EXATAMENTE UMA assinatura viva, de 5 argumentos',
      assinaturas.length === 1 && assinaturas[0].n === 5,
      assinaturas.map((x) => x.n).join(','));

  /*
   * SABOTAGEM. Devolve o `+` e exige que as duas propriedades novas caiam. Sem
   * isto, o bloco acima so registra numeros que passaram — e ja houve neste
   * repo sabotagem que nao mutou nada e imprimiu verde.
   */
  {
    const DE = 'set quantidade = excluded.quantidade,';
    const PARA = 'set quantidade = public.pedido_itens.quantidade + excluded.quantidade,';
    const sabotado = M49.replace(DE, PARA);
    chk('sabotagem: a mutacao entrou (o `+` voltou ao SQL)',
        sabotado !== M49 && !sabotado.includes(DE) && sabotado.includes(PARA));

    await c.query(sabotado);
    await c.query(`delete from public.pedido_itens i using public.pedidos p
                   where p.id = i.pedido_id and p.tenant_id=$1 and p.conversation_id=$2`, [A, CONV_A]);
    await c.query('select public.api_n8n_adicionar_item($1,$2,$3,$4)', [A, CONV_A, pA1.id, 3]);
    await c.query('select public.api_n8n_adicionar_item($1,$2,$3,$4)', [A, CONV_A, pA1.id, 3]);
    const sab = await um(`select max(quantidade) q from public.pedido_itens i
                          join public.pedidos p on p.id=i.pedido_id
                         where p.tenant_id=$1 and p.conversation_id=$2`, [A, CONV_A]);
    chk('sabotagem: com o `+`, a chamada repetida DOBRA (3 -> 6) e o teste reprova',
        sab.q === 6, `qtd=${sab.q} (esperado 6 sob a soma)`);

    // Restaura a 49 e o estado que o resto do arquivo espera.
    await c.query(M49);
    await c.query('select public.api_n8n_adicionar_item($1,$2,$3,$4,$5)', [A, CONV_A, pA1.id, 5, 'sem cebola']);
  }

  // --- o rollback pareado devolve a soma, e so isso ---
  {
    await c.query(R49);
    await c.query(`delete from public.pedido_itens i using public.pedidos p
                   where p.id = i.pedido_id and p.tenant_id=$1 and p.conversation_id=$2`, [A, CONV_A]);
    await c.query('select public.api_n8n_adicionar_item($1,$2,$3,$4)', [A, CONV_A, pA1.id, 2]);
    await c.query('select public.api_n8n_adicionar_item($1,$2,$3,$4)', [A, CONV_A, pA1.id, 3]);
    const rb = await um(`select max(quantidade) q from public.pedido_itens i
                         join public.pedidos p on p.id=i.pedido_id
                        where p.tenant_id=$1 and p.conversation_id=$2`, [A, CONV_A]);
    chk('o rollback da 49 devolve a SOMA (2 + 3 = 5)', rb.q === 5, `qtd=${rb.q}`);
    chk('e o ACL atravessa o rollback intacto', (await aclAdicionar()) === aclAntes49,
        `${await aclAdicionar()} vs ${aclAntes49}`);

    // Volta para a 49, que e o estado que esta entrega entrega.
    await c.query(M49);
    await c.query('select public.api_n8n_adicionar_item($1,$2,$3,$4,$5)', [A, CONV_A, pA1.id, 5, 'sem cebola']);
  }

  console.log('\n--- produto de OUTRO tenant e recusado ---');
  r = await um('select public.api_n8n_adicionar_item($1,$2,$3,$4) v', [A, CONV_A, pB.id, 1]);
  chk('recusa produto_id alheio', r.v.includes('nao esta disponivel'), r.v.slice(0, 70));
  const nLinhas = await um(`select count(*)::int n from public.pedido_itens i
                            join public.pedidos p on p.id=i.pedido_id where p.tenant_id=$1 and p.conversation_id=$2`, [A, CONV_A]);
  chk('nada entrou no carrinho', nLinhas.n === 1, `${nLinhas.n} linha(s)`);

  console.log('\n--- produto invisivel (pausado) e recusado ---');
  await c.query(`update public.produtos set disponivel=false where id=$1`, [pA2.id]);
  r = await um('select public.api_n8n_adicionar_item($1,$2,$3,$4) v', [A, CONV_A, pA2.id, 1]);
  chk('recusa produto pausado', r.v.includes('nao esta disponivel'));
  const busca = (await c.query(`select * from public.api_n8n_buscar_produtos($1,$2)`, [A, pA2.nome])).rows[0];
  chk('buscar_produtos tambem nao oferece', !busca.texto.includes(pA2.id), busca.texto.slice(0, 70));
  await c.query(`update public.produtos set disponivel=true where id=$1`, [pA2.id]);

  // -------------------------------------------------------------------------
  // Migracao 41: a busca informa QUANTOS existem, nao so a amostra
  // -------------------------------------------------------------------------
  // O DEFEITO que motivou: o agente do emporio (40 produtos) listou tres queijos
  // como se fosse o catalogo inteiro. `limit 10` sem contagem -- o agente recebia
  // N e apresentava N.
  console.log('\n--- 41: total no retorno ---');
  {
    const bp = async (termo) =>
      (await c.query('select * from public.api_n8n_buscar_produtos($1,$2)', [A, termo])).rows;

    // Catalogo grande o bastante para haver corte: 5 e o teto da amostra.
    for (let i = 0; i < 9; i++) {
      await c.query(
        `insert into public.produtos (tenant_id, nome, preco_centavos) values ($1,$2,$3)`,
        [A, `Item de teste 41 numero ${i}`, 1000 + i]);
    }

    const semTermo = await bp('');
    chk('devolve UMA linha, nao N', semTermo.length === 1, `${semTermo.length} linha(s)`);
    const t0 = semTermo[0];
    chk('sem termo: houve_busca = false', t0.houve_busca === false);
    chk('sem termo: total_catalogo conta tudo', t0.total_catalogo >= 10, `catalogo=${t0.total_catalogo}`);
    chk('amostra limitada a 5', t0.mostrando === 5, `mostrando=${t0.mostrando}`);
    chk('o texto diz o total do catalogo', t0.texto.includes(String(t0.total_catalogo)), t0.texto.split('\n')[0]);
    chk('o texto avisa que NAO houve busca', /sem busca/i.test(t0.texto), t0.texto.split('\n')[0]);
    chk('o texto tem no maximo 5 linhas de item',
      t0.texto.split('\n').length - 1 === 5, `${t0.texto.split('\n').length - 1} linhas`);

    const comCorte = await bp('Item de teste 41');
    const c0 = comCorte[0];
    chk('com termo: houve_busca = true', c0.houve_busca === true);
    chk('encontrado maior que mostrando', c0.total_encontrado > c0.mostrando,
      `${c0.total_encontrado} > ${c0.mostrando}`);
    chk('o texto diz encontrados E mostrando',
      c0.texto.includes(`${c0.total_encontrado} encontrados`) && c0.texto.includes(`mostrando ${c0.mostrando}`),
      c0.texto.split('\n')[0]);

    // O CASO QUE A FORMA ANTIGA NAO CONSEGUIA COMUNICAR: zero resultados COM
    // catalogo cheio. Antes vinham zero linhas, e zero linhas tambem e o que
    // vem de um tenant sem catalogo nenhum -- o agente nao distinguia.
    const zero = await bp('zzzz-termo-que-nao-existe');
    chk('busca sem resultado ainda devolve UMA linha', zero.length === 1, `${zero.length}`);
    const z0 = zero[0];
    chk('busca sem resultado: encontrado = 0', z0.total_encontrado === 0);
    chk('busca sem resultado: catalogo continua cheio', z0.total_catalogo >= 10, `catalogo=${z0.total_catalogo}`);
    chk('o texto distingue termo-sem-resultado de catalogo-vazio',
      z0.texto.includes('0 encontrados') && z0.texto.includes(String(z0.total_catalogo))
        && !/vazio/i.test(z0.texto),
      z0.texto);

    // E o outro lado da distincao: catalogo REALMENTE vazio.
    const vazio = (await c.query('select * from public.api_n8n_buscar_produtos($1,$2)', [B, 'x'])).rows[0];
    await c.query('update public.produtos set disponivel=false where tenant_id=$1', [B]);
    const vazioDeVerdade = (await c.query('select * from public.api_n8n_buscar_produtos($1,$2)', [B, ''])).rows[0];
    chk('catalogo vazio tem texto PROPRIO', /vazio/i.test(vazioDeVerdade.texto), vazioDeVerdade.texto);
    chk('e o de termo-sem-resultado NAO usa esse texto',
      vazioDeVerdade.texto !== z0.texto, 'os dois casos dizem a mesma coisa');
    void vazio;

    // O id tem de continuar no texto: sem ele o agente nao chama gerenciar_pedido.
    chk('cada linha da amostra carrega o id do produto',
      (t0.texto.match(/\(id: [0-9a-f-]{36}\)/g) ?? []).length === 5,
      `${(t0.texto.match(/\(id: [0-9a-f-]{36}\)/g) ?? []).length} ids`);
  }

  console.log('\n--- um pedido aberto por conversa ---');
  let erroUnico = null;
  try {
    await c.query('savepoint u');
    await c.query(`insert into public.pedidos (tenant_id, conversation_id, status) values ($1,$2,'rascunho')`, [A, CONV_A]);
    await c.query('release savepoint u');
  } catch (e) { erroUnico = e.code; await c.query('rollback to savepoint u'); }
  chk('segundo pedido aberto na mesma conversa e barrado', erroUnico === '23505', `codigo ${erroUnico}`);

  console.log('\n--- fechar_pedido ---');
  chk('tem_pedido_pendente = true com item', (await um('select public.api_n8n_tem_pedido_pendente($1,$2) v', [A, CONV_A])).v === true);
  r = await um(`select public.api_n8n_fechar_pedido($1,$2,$3::jsonb) v`, [A, CONV_A, JSON.stringify({ entrega: 'retirada' })]);
  chk('fecha e devolve numero + resumo', /Pedido nº \d+ fechado/.test(r.v) && r.v.includes('Total'), r.v.slice(0, 60));
  const fech = await um(`select status, numero, total_centavos, metadados from public.pedidos where tenant_id=$1 and conversation_id=$2`, [A, CONV_A]);
  chk('status aguardando_pagamento', fech.status === 'aguardando_pagamento');
  chk('numero atribuido', Number.isInteger(fech.numero) && fech.numero > 0, `numero=${fech.numero}`);
  chk('metadados mesclados', fech.metadados.entrega === 'retirada');
  chk('total = soma dos itens', fech.total_centavos === pA1.preco_centavos * 5);

  console.log('\n--- pedido fechado RECUSA alteracao ---');
  r = await um('select public.api_n8n_adicionar_item($1,$2,$3,$4) v', [A, CONV_A, pA1.id, 1]);
  chk('adicionar recusa com mensagem repassavel', r.v.includes('ja foi fechado'), r.v.slice(0, 60));
  r = await um('select public.api_n8n_remover_item($1,$2,$3) v', [A, CONV_A, pA1.id]);
  chk('remover recusa', r.v.includes('ja foi fechado'));
  const intacto = await um(`select total_centavos from public.pedidos where tenant_id=$1 and conversation_id=$2`, [A, CONV_A]);
  chk('total do pedido fechado nao mudou', intacto.total_centavos === pA1.preco_centavos * 5);

  console.log('\n--- cancelar libera a conversa ---');
  r = await um('select public.api_n8n_cancelar_pedido($1,$2) v', [A, CONV_A]);
  chk('cancela pedido ja fechado', r.v.includes('cancelado'), r.v.slice(0, 60));
  chk('tem_pedido_pendente volta a false', (await um('select public.api_n8n_tem_pedido_pendente($1,$2) v', [A, CONV_A])).v === false);
  r = await um('select public.api_n8n_adicionar_item($1,$2,$3,$4) v', [A, CONV_A, pA1.id, 1]);
  chk('novo pedido abre depois do cancelamento', r.v.includes('Pedido atual'), r.v.slice(0, 50));

  console.log('\n--- rascunho vazio NAO bloqueia resolver_conversa ---');
  await c.query(`delete from public.pedido_itens i using public.pedidos p
                 where i.pedido_id=p.id and p.tenant_id=$1 and p.conversation_id=$2 and p.status='rascunho'`, [A, CONV_A]);
  chk('pendente=false com rascunho vazio', (await um('select public.api_n8n_tem_pedido_pendente($1,$2) v', [A, CONV_A])).v === false);

  console.log('\n--- ISOLAMENTO: tenant B nao alcanca pedido de A ---');
  await c.query('select public.api_n8n_adicionar_item($1,$2,$3,$4)', [A, CONV_A, pA1.id, 2]);
  const idPedidoA = (await um(`select id from public.pedidos where tenant_id=$1 and conversation_id=$2 and status='rascunho'`, [A, CONV_A])).id;
  r = await um('select public.api_n8n_ver_pedido($1,$2) v', [B, CONV_A]);
  chk('B com a MESMA conversation_id nao ve o pedido de A', r.v.includes('Nao ha pedido aberto'), r.v.slice(0, 50));
  r = await um('select public.api_n8n_adicionar_item($1,$2,$3,$4) v', [B, CONV_A, pA1.id, 1]);
  chk('B nao adiciona produto de A', r.v.includes('nao esta disponivel'));
  const donoA = await um(`select tenant_id from public.pedidos where id=$1`, [idPedidoA]);
  chk('pedido de A segue de A', donoA.tenant_id === A);
  r = await um('select public.api_n8n_cancelar_pedido($1,$2) v', [B, CONV_A]);
  chk('B nao cancela pedido de A', r.v.includes('Nao ha pedido aberto'));
  const vivoA = await um(`select status from public.pedidos where id=$1`, [idPedidoA]);
  chk('pedido de A continua rascunho', vivoA.status === 'rascunho', `status=${vivoA.status}`);

  console.log('\n--- tenant_id do item nao pode ser forjado ---');
  await c.query(`insert into public.pedido_itens (tenant_id, pedido_id, produto_id, nome_snapshot, preco_unit_centavos, quantidade)
                 values ($1,$2,$3,'forjado',100,1)`, [B, idPedidoA, pA2.id]);
  const forjado = await um(`select tenant_id from public.pedido_itens where nome_snapshot='forjado'`);
  chk('trigger sobrescreve tenant_id alheio com o dono do pedido', forjado.tenant_id === A, `veio ${forjado.tenant_id}`);

  console.log('\n--- rollback recusa apagar pedido ---');
  await c.query('savepoint rb');
  let recusou = false;
  try { await c.query(R26); await c.query(R25); } catch (e) { recusou = /Abortado/.test(e.message); }
  chk('rollback da 25 aborta com pedidos existentes', recusou);
  await c.query('rollback to savepoint rb');

  console.log('\n--- rollback limpo (sem pedidos) ---');
  await c.query('delete from public.pedido_itens'); await c.query('delete from public.pedidos');
  await c.query(R26); await c.query(R25);
  const restou = await um(`select count(*)::int n from information_schema.tables
                           where table_schema='public' and table_name in ('pedidos','pedido_itens')`);
  const fn = await um(`select count(*)::int n from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
                       where ns.nspname='public' and p.proname like 'api_n8n_%' and p.proname in
                       ('api_n8n_buscar_produtos','api_n8n_adicionar_item','api_n8n_fechar_pedido')`);
  chk('tabelas removidas', restou.n === 0);
  chk('funcoes removidas', fn.n === 0);
} catch (e) {
  console.log('\nERRO:', e.message);
  falhas.push('excecao: ' + e.message);
}
await c.query('rollback');
console.log('\n=== transacao revertida; producao intacta ===');
console.log(`${ok} passaram, ${falhas.length} falharam`);
if (falhas.length) { console.log('\nFALHAS:'); falhas.forEach(f => console.log('  - ' + f)); }
await c.end();
process.exit(falhas.length ? 1 : 0);
