#!/usr/bin/env node
/**
 * Migração 55 — pedido novo depois de fechar.
 *
 * O QUE ELA MUDA. `uq_pedidos_conversa_aberta` cobria `rascunho` E
 * `aguardando_pagamento`, então uma conversa não podia ter um segundo pedido: o
 * cliente que acabava de comprar ficava até 24 h sem conseguir comprar de novo,
 * e `adicionar_item` recusava com "é preciso cancelar e refazer" — instrução
 * que, seguida, CANCELA A VENDA JÁ FEITA. Ver
 * docs/PENDENCIA-VENDA-AFIRMADA-SEM-TOOL.md.
 *
 * COMEÇA PELO ROLLBACK, e isso não é zelo. O rollback é idempotente e põe o
 * banco no estado pré-migração tendo ela sido aplicada ou não — sem isso, o
 * teste estaria afirmando o CALENDÁRIO ("a 55 ainda não subiu"), que é o nono
 * caso da série registrada no CLAUDE.md e apareceu duas vezes seguidas.
 *
 * TUDO EM UMA TRANSAÇÃO ABORTADA, numa conexão só: nada é comitado, nem os
 * tenants efêmeros. Por isso aqui não vale a limpeza por padrão de nome (e nem
 * é preciso) — o `rollback` do fim é o escopo.
 *
 * CADA ASSERÇÃO NOVA TEM SABOTAGEM. A parte 4 quebra de propósito o que a
 * parte 3 afirma e exige que fique vermelho. Sem isso não há como saber se a
 * asserção mede alguma coisa — foi assim que o repo achou seis defeitos numa
 * semana que revisão não pegou.
 *
 * Uso: npm run teste:migracao-pedido-novo
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

const RAIZ = fileURLToPath(new URL('../', import.meta.url));
const env = fs.readFileSync(path.join(RAIZ, '.env.local'), 'utf8');
const URL_BANCO = env
  .split(/\r?\n/)
  .find((l) => l.startsWith('SUPABASE_DB_URL='))
  ?.slice('SUPABASE_DB_URL='.length)
  .trim()
  .replace(/^["']|["']$/g, '');

if (!URL_BANCO) {
  console.error('\n  SUPABASE_DB_URL ausente no .env.local\n');
  process.exit(64);
}

const MIG = path.join(RAIZ, 'supabase/migrations/20260828170000_55_pedido_novo_apos_fechar.sql');
const RBK = path.join(RAIZ, 'supabase/migrations/20260828170000_55_pedido_novo_apos_fechar_rollback.sql');

/** O arquivo traz `begin`/`commit`; aqui a transação é nossa e não pode fechar. */
const semTx = (s) => s.replace(/^\s*begin\s*;\s*$/gim, '').replace(/^\s*commit\s*;\s*$/gim, '');
const sql55 = semTx(fs.readFileSync(MIG, 'utf8'));
const sqlRb = semTx(fs.readFileSync(RBK, 'utf8'));

let passou = 0;
const falhas = [];

function chk(nome, ok, detalhe = '') {
  if (ok) {
    passou++;
    console.log(`  OK    ${nome}`);
  } else {
    falhas.push(`${nome}${detalhe ? ` — ${detalhe}` : ''}`);
    console.log(`  FALHA ${nome}${detalhe ? ` — ${detalhe}` : ''}`);
  }
}

const c = new Client({ connectionString: URL_BANCO, ssl: { rejectUnauthorized: false } });
await c.connect();

/**
 * REJEIÇÃO INESPERADA VIRA VALOR, NÃO CRASH. `await` cru numa chamada que a
 * sabotagem faz estourar derruba o processo antes das asserções seguintes, e aí
 * não se sabe qual propriedade quebrou.
 *
 * Dentro de uma transação, porém, um erro do Postgres a deixa ABORTADA e todo
 * comando seguinte falha com 25P02. Por isso cada chamada que pode estourar vai
 * num savepoint próprio, revertido no erro.
 */
async function tentar(sql, args = []) {
  await c.query('savepoint sp');
  try {
    const r = await c.query(sql, args);
    await c.query('release savepoint sp');
    return { ok: true, valor: r.rows[0] ? Object.values(r.rows[0])[0] : null, erro: null };
  } catch (e) {
    await c.query('rollback to savepoint sp');
    await c.query('release savepoint sp');
    return { ok: false, valor: null, erro: e.message };
  }
}

const CONV = 970055;
let TENANT = null;
let PRODUTO_A = null;
let PRODUTO_B = null;

async function estado() {
  const { rows } = await c.query(
    `select p.numero, p.status, p.total_centavos
       from public.pedidos p where p.tenant_id = $1 and p.conversation_id = $2
      order by p.criado_em`,
    [TENANT, CONV],
  );
  return rows;
}

async function aplicar(sql) {
  const r = await tentar(sql);
  return r;
}

await c.query('begin');

try {
  // =========================================================================
  console.log('\n-- 0. Estado pré-migração, via rollback (não via calendário) --\n');
  // =========================================================================
  {
    const r = await aplicar(sqlRb);
    chk('o rollback da 55 aplica sobre o estado atual, seja ele qual for', r.ok, r.erro ?? '');
    if (!r.ok) throw new Error('sem estado pré-migração não há o que medir');
  }

  const { rows: [t] } = await c.query(
    `insert into public.tenants (slug, nome) values ($1, $2) returning id`,
    [`zz-efem-mig55-${Math.random().toString(16).slice(2, 10)}`, 'efêmero migração 55'],
  );
  TENANT = t.id;

  const { rows: prods } = await c.query(
    `insert into public.produtos (tenant_id, nome, preco_centavos, disponivel)
     values ($1, 'sonda A', 1000, true), ($1, 'sonda B', 2500, true)
     returning id, nome order by nome`,
    [TENANT],
  );
  PRODUTO_A = prods[0].id;
  PRODUTO_B = prods[1].id;
  chk('tenant efêmero e dois produtos criados dentro da transação', !!TENANT && !!PRODUTO_B);

  // =========================================================================
  console.log('\n-- 1. O beco que a 55 existe para tirar (mundo ANTES) --\n');
  // =========================================================================
  {
    await tentar(`select public.api_n8n_adicionar_item($1,$2,$3,1,null)`, [TENANT, CONV, PRODUTO_A]);
    await tentar(`select public.api_n8n_fechar_pedido($1,$2,'{}')`, [TENANT, CONV]);

    const r = await tentar(`select public.api_n8n_adicionar_item($1,$2,$3,1,null)`, [TENANT, CONV, PRODUTO_B]);
    chk(
      'ANTES: adicionar depois de fechar é RECUSADO, mandando cancelar e refazer',
      r.ok && /ja foi fechado/i.test(String(r.valor)) && /cancelar e refazer/i.test(String(r.valor)),
      String(r.valor).slice(0, 120),
    );

    const linhas = await estado();
    chk('ANTES: continua existindo UM pedido só na conversa', linhas.length === 1, JSON.stringify(linhas));

    // CONTRAPROVA do índice antigo: a recusa acima poderia vir de outra coisa.
    const ins = await tentar(
      `insert into public.pedidos (tenant_id, conversation_id, status) values ($1,$2,'rascunho')`,
      [TENANT, CONV],
    );
    chk(
      'ANTES: o índice antigo PROÍBE um segundo pedido, mesmo por insert direto',
      !ins.ok && /uq_pedidos_conversa_aberta|unique/i.test(String(ins.erro)),
      String(ins.erro).slice(0, 120),
    );
  }

  // =========================================================================
  console.log('\n-- 2. A migração aplica, e é reexecutável --\n');
  // =========================================================================
  {
    const antes = await estado();
    const r1 = await aplicar(sql55);
    chk('a 55 aplica', r1.ok, r1.erro ?? '');
    if (!r1.ok) throw new Error('sem a 55 aplicada não há o que medir');

    const r2 = await aplicar(sql55);
    chk('a 55 é reexecutável (aplicar duas vezes não quebra)', r2.ok, r2.erro ?? '');

    const depois = await estado();
    // PROPRIEDADE, não estado do mundo: não afirma "existe 1 pedido", afirma
    // que APLICAR não mexeu em nenhum. Vale com qualquer conteúdo no banco.
    chk(
      'aplicar a 55 não altera nenhum pedido existente',
      JSON.stringify(antes) === JSON.stringify(depois),
      `${JSON.stringify(antes)} -> ${JSON.stringify(depois)}`,
    );
  }

  // =========================================================================
  console.log('\n-- 3. O comportamento novo --\n');
  // =========================================================================
  {
    const r = await tentar(`select public.api_n8n_adicionar_item($1,$2,$3,1,null)`, [TENANT, CONV, PRODUTO_B]);
    chk('DEPOIS: adicionar depois de fechar ABRE pedido novo', r.ok && /sonda B/i.test(String(r.valor)),
      String(r.valor).slice(0, 160));
    chk(
      'DEPOIS: e diz ao cliente que é um pedido NOVO, com o número do anterior',
      r.ok && /pedido NOVO/i.test(String(r.valor)) && /nº 1/.test(String(r.valor)),
      String(r.valor).slice(0, 160),
    );

    const linhas = await estado();
    chk('DEPOIS: a conversa tem DOIS pedidos vivos', linhas.length === 2, JSON.stringify(linhas));
    chk(
      'DEPOIS: a venda antiga segue intacta (nº 1, aguardando_pagamento, 1000)',
      linhas.some((l) => l.numero === 1 && l.status === 'aguardando_pagamento' && l.total_centavos === 1000),
      JSON.stringify(linhas),
    );
  }

  {
    // INVARIANTE da migração: esta é a única das seis que NÃO pode mudar.
    const r = await tentar(`select public.api_n8n_tem_pedido_pendente($1,$2)`, [TENANT, CONV]);
    chk('INVARIANTE: tem_pedido_pendente segue true com venda fechada na conversa', r.valor === true,
      `veio ${r.valor}`);

    // ...e o caso que a torna não-vácua: conversa SEM nada devolve false.
    const vazio = await tentar(`select public.api_n8n_tem_pedido_pendente($1,$2)`, [TENANT, CONV + 1]);
    chk('CONTRAPROVA: conversa sem pedido nenhum devolve false', vazio.valor === false, `veio ${vazio.valor}`);
  }

  {
    const r = await tentar(`select public.api_n8n_ver_pedido($1,$2)`, [TENANT, CONV]);
    chk('ver_pedido responde com o CARRINHO quando ele existe', r.ok && /sonda B/i.test(String(r.valor)),
      String(r.valor).slice(0, 120));
  }

  // =========================================================================
  console.log('\n-- 4. cancelar_pedido: o alvo explícito e o default seguro --\n');
  // =========================================================================
  {
    const r = await tentar(`select public.api_n8n_cancelar_pedido($1,$2)`, [TENANT, CONV]);
    chk('sem argumento, cancela o CARRINHO', r.ok && /carrinho descartado/i.test(String(r.valor)),
      String(r.valor).slice(0, 120));

    const linhas = await estado();
    chk(
      'SEM ARGUMENTO NÃO TOCA A VENDA FECHADA — a propriedade que a opção 3 comprou',
      linhas.some((l) => l.numero === 1 && l.status === 'aguardando_pagamento'),
      JSON.stringify(linhas),
    );

    // Texto solto cai no carrinho, não em "extraí um número de qualquer lugar".
    await tentar(`select public.api_n8n_adicionar_item($1,$2,$3,1,null)`, [TENANT, CONV, PRODUTO_B]);
    const solto = await tentar(`select public.api_n8n_cancelar_pedido($1,$2,$3)`, [TENANT, CONV, '1 item']);
    chk(
      'alvo com texto solto ("1 item") cai no carrinho, e NÃO no pedido nº 1',
      solto.ok && /carrinho descartado/i.test(String(solto.valor)),
      String(solto.valor).slice(0, 120),
    );
    chk(
      'e o pedido nº 1 continua de pé depois disso',
      (await estado()).some((l) => l.numero === 1 && l.status === 'aguardando_pagamento'),
    );

    const num = await tentar(`select public.api_n8n_cancelar_pedido($1,$2,$3)`, [TENANT, CONV, '1']);
    chk('com o NÚMERO, cancela a venda', num.ok && /nº 1.*cancelado/i.test(String(num.valor)),
      String(num.valor).slice(0, 120));
    chk('e o banco confirma', (await estado()).some((l) => l.numero === 1 && l.status === 'cancelado'));

    const errado = await tentar(`select public.api_n8n_cancelar_pedido($1,$2,$3)`, [TENANT, CONV, '99']);
    chk('número inexistente é RECUSA, não estrago', errado.ok && /NADA FOI CANCELADO/.test(String(errado.valor)),
      String(errado.valor).slice(0, 120));
  }

  // =========================================================================
  console.log('\n-- 5. As mensagens que o modelo lê --\n');
  // =========================================================================
  {
    const r = await tentar(`select public.api_n8n_fechar_pedido($1,$2,'{}')`, [TENANT, CONV + 2]);
    chk(
      'fechar sem carrinho começa por NADA FOI FECHADO (antes parecia sucesso)',
      r.ok && String(r.valor).startsWith('NADA FOI FECHADO'),
      String(r.valor).slice(0, 140),
    );

    const canc = await tentar(`select public.api_n8n_cancelar_pedido($1,$2)`, [TENANT, CONV + 2]);
    chk(
      'cancelar não promete mais "a conversa está livre para um novo pedido"',
      canc.ok && !/livre para um novo pedido/i.test(String(canc.valor)),
      String(canc.valor).slice(0, 140),
    );
  }

  // =========================================================================
  console.log('\n-- 6. Catálogo: órfãs, índices e ACL --\n');
  // =========================================================================
  {
    const { rows: orfas } = await c.query(
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.prosrc ilike '%pedido\\_aberto\\_da\\_conversa%'`,
    );
    chk('nenhuma função ainda cita pedido_aberto_da_conversa', orfas.length === 0,
      orfas.map((r) => r.proname).join(', '));

    const { rows: velha } = await c.query(
      `select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'pedido_aberto_da_conversa'`,
    );
    chk('pedido_aberto_da_conversa foi dropada', velha.length === 0);

    const { rows: idx } = await c.query(
      `select indexname from pg_indexes where schemaname = 'public'
        and indexname in ('uq_pedidos_conversa_rascunho','uq_pedidos_conversa_aberta')`,
    );
    const nomes = idx.map((r) => r.indexname);
    chk('o índice novo existe e o antigo saiu', nomes.includes('uq_pedidos_conversa_rascunho')
      && !nomes.includes('uq_pedidos_conversa_aberta'), nomes.join(', '));

    // FORMA do ACL, igual ao teste:grants-n8n. Helper NÃO leva n8n_agent: quem
    // o chama é uma SECURITY DEFINER que roda como `postgres`.
    const { rows: acl } = await c.query(
      `select p.proname,
              coalesce((select string_agg(split_part(a::text,'=',1), '+' order by split_part(a::text,'=',1))
                          from unnest(p.proacl) a), '(NULO)') as forma
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname in ('pedido_rascunho_da_conversa','pedido_fechado_da_conversa','api_n8n_cancelar_pedido')
        order by p.proname`,
    );
    const forma = Object.fromEntries(acl.map((r) => [r.proname, r.forma]));
    chk('helper novo pedido_rascunho_da_conversa tem a forma de helper',
      forma.pedido_rascunho_da_conversa === 'postgres+service_role', forma.pedido_rascunho_da_conversa);
    chk('helper novo pedido_fechado_da_conversa tem a forma de helper',
      forma.pedido_fechado_da_conversa === 'postgres+service_role', forma.pedido_fechado_da_conversa);
    chk('api_n8n_cancelar_pedido recriada tem a forma da superfície',
      forma.api_n8n_cancelar_pedido === 'n8n_agent+postgres+service_role', forma.api_n8n_cancelar_pedido);

    // ARIDADE: a família 28/32/37. Duas assinaturas vivas tornam a chamada
    // ambígua, e a ambiguidade só aparece em runtime, no primeiro cliente.
    const { rows: assin } = await c.query(
      `select count(*)::int n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
        where ns.nspname = 'public' and p.proname = 'api_n8n_cancelar_pedido'`,
    );
    chk('api_n8n_cancelar_pedido tem UMA assinatura viva', assin[0].n === 1, `veio ${assin[0].n}`);

    // E a prova funcional: o ACL diz o que contém, chamar diz o que acontece.
    const comoAgente = await tentar(
      `set local role n8n_agent; select public.api_n8n_cancelar_pedido($1,$2)`, [TENANT, CONV + 3],
    );
    await tentar(`reset role`);
    chk('n8n_agent consegue chamar cancelar_pedido de verdade', comoAgente.ok, comoAgente.erro ?? '');
  }

  // =========================================================================
  console.log('\n-- 7. SABOTAGEM: cada asserção acima tem de saber ficar vermelha --\n');
  // =========================================================================
  {
    // 7a. tem_pedido_pendente apontada só para o carrinho — a invariante.
    await c.query('savepoint sab');
    await c.query(`
      create or replace function public.api_n8n_tem_pedido_pendente(p_tenant_id uuid, p_conversation_id bigint)
      returns boolean language plpgsql volatile security definer set search_path to 'public'
      as $f$ begin
        return exists (select 1 from public.pedidos p
                        where p.tenant_id = p_tenant_id and p.conversation_id = p_conversation_id
                          and p.status = 'rascunho' and p.deletado_em is null
                          and exists (select 1 from public.pedido_itens i where i.pedido_id = p.id));
      end $f$;`);
    // CONFIRME QUE A MUTAÇÃO ENTROU antes de acreditar no resultado.
    const { rows: [corpo] } = await c.query(
      `select (prosrc ilike '%aguardando\\_pagamento%') as ve_venda from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname='public' and p.proname='api_n8n_tem_pedido_pendente'`,
    );
    chk('sabotagem 7a entrou (a função deixou de citar aguardando_pagamento)', corpo.ve_venda === false);

    await tentar(`select public.api_n8n_adicionar_item($1,$2,$3,1,null)`, [TENANT, CONV + 4, PRODUTO_A]);
    await tentar(`select public.api_n8n_fechar_pedido($1,$2,'{}')`, [TENANT, CONV + 4]);
    const sab = await tentar(`select public.api_n8n_tem_pedido_pendente($1,$2)`, [TENANT, CONV + 4]);
    chk(
      'sabotagem 7a REPROVA: com a função só olhando o carrinho, a invariante cai',
      sab.valor === false,
      `veio ${sab.valor} — se veio true, a asserção da parte 3 é vácua`,
    );
    await c.query('rollback to savepoint sab');
    await c.query('release savepoint sab');

    const volta = await tentar(`select public.api_n8n_tem_pedido_pendente($1,$2)`, [TENANT, CONV + 4]);
    chk('e a função restaurada volta a enxergar a venda', volta.valor === true, `veio ${volta.valor}`);
  }

  {
    // 7b. cancelar_pedido com default apontado para a venda — o desenho recusado
    // (opção 2). Tem de derrubar a asserção de "não toca a venda fechada".
    await c.query('savepoint sab2');
    await c.query(`
      create or replace function public.api_n8n_cancelar_pedido(
        p_tenant_id uuid, p_conversation_id bigint, p_alvo text default null)
      returns text language plpgsql security definer set search_path to 'public'
      as $f$ declare v_p uuid; begin
        v_p := coalesce(public.pedido_rascunho_da_conversa(p_tenant_id, p_conversation_id),
                        public.pedido_fechado_da_conversa(p_tenant_id, p_conversation_id));
        if v_p is null then return 'nada'; end if;
        update public.pedidos set status = 'cancelado' where id = v_p;
        return 'Carrinho descartado.';
      end $f$;`);

    await tentar(`select public.api_n8n_adicionar_item($1,$2,$3,1,null)`, [TENANT, CONV + 5, PRODUTO_A]);
    await tentar(`select public.api_n8n_fechar_pedido($1,$2,'{}')`, [TENANT, CONV + 5]);
    const { rows: [pre] } = await c.query(
      `select status from public.pedidos where tenant_id=$1 and conversation_id=$2`, [TENANT, CONV + 5]);
    chk('sabotagem 7b arranjou o estado (venda fechada, sem carrinho)',
      pre?.status === 'aguardando_pagamento', pre?.status);

    await tentar(`select public.api_n8n_cancelar_pedido($1,$2)`, [TENANT, CONV + 5]);
    const { rows: [pos] } = await c.query(
      `select status from public.pedidos where tenant_id=$1 and conversation_id=$2`, [TENANT, CONV + 5]);
    chk(
      'sabotagem 7b REPROVA: com fallback para a venda, o cancelar sem argumento a destrói',
      pos?.status === 'cancelado',
      `veio ${pos?.status} — se não cancelou, a asserção da parte 4 é vácua`,
    );
    await c.query('rollback to savepoint sab2');
    await c.query('release savepoint sab2');
  }

  // =========================================================================
  console.log('\n-- 8. Rollback da 55 --\n');
  // =========================================================================
  {
    // Não pode haver conversa com dois pedidos vivos, senão o rollback aborta
    // de propósito — que é o comportamento certo e está documentado no arquivo.
    await c.query(
      `update public.pedidos set status = 'cancelado'
        where tenant_id = $1 and status in ('rascunho','aguardando_pagamento')`, [TENANT]);

    const r = await aplicar(sqlRb);
    chk('o rollback aplica', r.ok, r.erro ?? '');

    const { rows: velha } = await c.query(
      `select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'pedido_aberto_da_conversa'`,
    );
    chk('pedido_aberto_da_conversa volta a existir', velha.length === 1);

    const { rows: novos } = await c.query(
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname='public'
          and p.proname in ('pedido_rascunho_da_conversa','pedido_fechado_da_conversa')`,
    );
    chk('os helpers da 55 somem', novos.length === 0, novos.map((r) => r.proname).join(', '));

    const { rows: assin } = await c.query(
      `select pg_get_function_identity_arguments(p.oid) args
         from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
        where ns.nspname='public' and p.proname='api_n8n_cancelar_pedido'`,
    );
    chk('cancelar_pedido volta a UMA assinatura, de 2 argumentos',
      assin.length === 1 && !/text/.test(assin[0].args), JSON.stringify(assin.map((a) => a.args)));

    const { rows: acl } = await c.query(
      `select coalesce((select string_agg(split_part(a::text,'=',1),'+' order by split_part(a::text,'=',1))
                          from unnest(p.proacl) a), '(NULO)') forma
         from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
        where ns.nspname='public' and p.proname='api_n8n_cancelar_pedido'`,
    );
    chk('e os grants voltam nos DOIS roles (a armadilha das migrações 40 e 41)',
      acl[0]?.forma === 'n8n_agent+postgres+service_role', acl[0]?.forma);

    const { rows: idx } = await c.query(
      `select indexname from pg_indexes where schemaname='public'
        and indexname in ('uq_pedidos_conversa_rascunho','uq_pedidos_conversa_aberta')`,
    );
    const nomes = idx.map((r) => r.indexname);
    chk('o índice antigo volta e o novo sai',
      nomes.includes('uq_pedidos_conversa_aberta') && !nomes.includes('uq_pedidos_conversa_rascunho'),
      nomes.join(', '));
  }

  {
    // 8b. O rollback ABORTA quando há conversa com dois pedidos vivos. É o
    // comportamento desenhado, e sem esta asserção ninguém saberia que ele
    // existe até precisar dele.
    await aplicar(sql55);
    await tentar(`select public.api_n8n_adicionar_item($1,$2,$3,1,null)`, [TENANT, CONV + 6, PRODUTO_A]);
    await tentar(`select public.api_n8n_fechar_pedido($1,$2,'{}')`, [TENANT, CONV + 6]);
    await tentar(`select public.api_n8n_adicionar_item($1,$2,$3,1,null)`, [TENANT, CONV + 6, PRODUTO_B]);

    const { rows: [n] } = await c.query(
      `select count(*)::int n from public.pedidos
        where tenant_id=$1 and conversation_id=$2 and status in ('rascunho','aguardando_pagamento')`,
      [TENANT, CONV + 6]);
    chk('8b arranjou o estado: dois pedidos vivos na mesma conversa', n.n === 2, `veio ${n.n}`);

    const r = await aplicar(sqlRb);
    chk(
      'o rollback ABORTA com mensagem própria em vez de estourar unicidade crua',
      !r.ok && /ROLLBACK DA 55 IMPOSSIVEL/i.test(String(r.erro)),
      String(r.erro).slice(0, 160),
    );
  }
} catch (e) {
  falhas.push(`ERRO INESPERADO: ${e.message}`);
  console.log(`  FALHA ERRO INESPERADO: ${e.message}`);
} finally {
  // NADA É COMITADO. Tenant efêmero, produtos, pedidos e as duas versões do
  // schema desaparecem juntos.
  await c.query('rollback').catch(() => {});
  await c.end();
}

console.log(`\n${'-'.repeat(60)}`);
console.log(`  ${passou} passaram, ${falhas.length} falharam\n`);
if (falhas.length) {
  for (const f of falhas) console.log(`   - ${f}`);
  console.log('');
  process.exitCode = 1;
}
