#!/usr/bin/env node
/**
 * Migração 61 (esqueleto de pagamento via Asaas) em TRANSAÇÃO ABORTADA contra
 * produção. Nada é gravado.
 *
 * COMEÇA PELO ROLLBACK da própria migração — põe o banco no estado pré-61 tendo
 * ela sido aplicada ou não, então este arquivo não afirma o calendário.
 *
 * ---------------------------------------------------------------------------
 * OS TRÊS CASOS QUE O ENUNCIADO NOMEOU, E ONDE CADA UM ESTÁ
 *
 *   1. "um teste que afirme «o agente não confirma pagamento» passa numa
 *      implementação em que a ferramenta de gerar link também nunca funciona."
 *      -> §5 afirma que o LINK É GERADO (ok, com valor vindo do banco) e §6
 *         afirma que o status só muda pelo webhook. Os dois lados, e uma
 *         implementação morta reprova no primeiro.
 *
 *   2. o espelho da regra 3 -> `tests/portao-pagamento.mjs` §2. Aqui o espelho
 *      correspondente é §6: o webhook APLICA (o caminho positivo existe) e §9,
 *      onde o pedido fora do prazo NÃO é aplicado.
 *
 *   3. "idempotência: reenviar o mesmo webhook não pode produzir efeito nenhum
 *      na segunda vez. Verifique o ESTADO DO BANCO, não só que a resposta foi
 *      200."
 *      -> §7 tira um retrato do banco (contagens + `pago_em` + `atualizado_em`)
 *         antes e depois do reenvio e exige que ele seja IDÊNTICO. E §8 cobre o
 *         caso que a dedup por evento NÃO pega: dois eventos DIFERENTES sobre o
 *         mesmo pagamento (CONFIRMED depois de RECEIVED).
 *
 * ---------------------------------------------------------------------------
 * TENANTS EFÊMEROS, e não os slugs do seed: este teste ARRANJA o estado que
 * mede (tenant, credencial, pedido fechado), em vez de contar com o que
 * produção por acaso tem. Nenhuma linha de tenant real é tocada.
 *
 * Uso: npm run teste:pagamento-asaas
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(RAIZ, 'supabase', 'migrations');
const leia = (n) => fs.readFileSync(path.join(DIR, n), 'utf8').replace(/\r\n/g, '\n');
const M61 = leia('20260910230000_61_pagamento_asaas_sandbox.sql');
const R61 = leia('20260910230000_61_pagamento_asaas_sandbox_rollback.sql');
const semTx = (s) => s.replace(/^\s*(begin|commit)\s*;\s*$/gim, '');
const md5 = (t) => crypto.createHash('md5').update(t, 'utf8').digest('hex').slice(0, 12);

let ok = 0;
const falhas = [];
const chk = (nome, cond, det = '') => {
  if (cond) { ok++; console.log(`  OK    ${nome}`); }
  else { falhas.push(nome); console.log(`  FALHA ${nome}${det ? ` — ${det}` : ''}`); }
};

const url = fs.readFileSync(path.join(RAIZ, '.env.local'), 'utf8')
  .split(/\r?\n/).find((l) => l.startsWith('SUPABASE_DB_URL='))
  .slice('SUPABASE_DB_URL='.length).trim().replace(/^["']|["']$/g, '');

const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await c.connect();
await c.query('begin');

const um = async (sql, p = []) => (await c.query(sql, p)).rows[0];
const tudo = async (sql, p = []) => (await c.query(sql, p)).rows;
const existeCol = async (t, col) => (await um(
  `select count(*)::int n from information_schema.columns
    where table_schema='public' and table_name=$1 and column_name=$2`, [t, col])).n === 1;
const aclDe = async (nome) => (await um(
  `select coalesce(string_agg(coalesce(p.proacl::text,'(NULO)'), ' | ' order by p.oid), '(AUSENTE)') acl
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname=$1`, [nome])).acl;

// Token de 32+ caracteres, que é a regra do próprio Asaas.
const TOKEN_A = 'tokdeteste' + 'a'.repeat(30);
const TOKEN_B = 'tokdeteste' + 'b'.repeat(30);

let TA = null;   // tenant A (efêmero)
let TB = null;   // tenant B (efêmero) — isolamento
const CONV_A = 990001;
const CONV_B = 990002;

/** Cria um tenant efêmero com credencial Asaas e a tool `pagamento` contratada. */
async function tenantComPagamento(sufixo, token) {
  const t = await um(
    `insert into public.tenants (slug, nome, chatwoot_account_id, chatwoot_inbox_id)
     values ($1, $2, null, null) returning id`,
    [`z-teste-pag-${sufixo}`, `Teste Pagamento ${sufixo}`]);
  await c.query(
    `insert into public.tenant_credenciais (tenant_id, asaas_ambiente, asaas_api_key_sandbox,
       asaas_webhook_token_sandbox, asaas_api_key_producao, asaas_webhook_token_producao)
     values ($1, 'sandbox', $2, $3, $4, $5)`,
    [t.id, `sk_sandbox_${sufixo}`, token, `sk_prod_${sufixo}`, token.replace(/.$/, 'Z')]);
  await c.query(
    `insert into public.tenant_tools (tenant_id, tool_nome, ativo, contratado)
     values ($1, 'pagamento', true, true)`, [t.id]);
  return t.id;
}

/**
 * Pedido fechado, com um item, valendo `centavos`.
 *
 * `numero` vem de um CONTADOR e não de uma constante: `uq_pedidos_tenant_numero`
 * é único por tenant, e a primeira versão daqui usava 991 fixo — o segundo
 * pedido do mesmo tenant estourava `23505` no meio da §8.
 */
let proximoNumero = 991;
async function pedidoFechado(tenantId, conversationId, centavos) {
  const numero = proximoNumero++;
  const prod = await um(
    `insert into public.produtos (tenant_id, nome, preco_centavos, unidade, disponivel)
     values ($1, 'Item de teste', $2, 'un', true) returning id`, [tenantId, centavos]);
  const ped = await um(
    `insert into public.pedidos (tenant_id, conversation_id, status, numero)
     values ($1, $2, 'aguardando_pagamento', $3) returning id`, [tenantId, conversationId, numero]);
  await c.query(
    `insert into public.pedido_itens (tenant_id, pedido_id, produto_id, nome_snapshot,
       quantidade, preco_unit_centavos)
     values ($1, $2, $3, 'Item de teste', 1, $4)`, [tenantId, ped.id, prod.id, centavos]);
  // `pedidos_recalcula_total` já põe o total; conferido abaixo em vez de assumido.
  return ped.id;
}

/** Retrato do estado que a idempotência não pode mexer. */
async function retrato(tenantId) {
  const r = await um(
    `select
       (select count(*)::int from public.pagamento_eventos where tenant_id=$1) eventos,
       (select count(*)::int from public.pedido_cobrancas  where tenant_id=$1) cobrancas,
       (select count(*)::int from public.pedidos where tenant_id=$1 and status='pago') pagos,
       (select coalesce(string_agg(c.id::text || '|' || coalesce(c.pago_em::text,'-')
                                   || '|' || coalesce(c.pagamento_id,'-')
                                   || '|' || c.atualizado_em::text, ',' order by c.id), '')
          from public.pedido_cobrancas c where c.tenant_id=$1) cobrancas_detalhe,
       (select coalesce(string_agg(p.id::text || '|' || p.status || '|' || p.atualizado_em::text,
                                   ',' order by p.id), '')
          from public.pedidos p where p.tenant_id=$1) pedidos_detalhe`, [tenantId]);
  return md5(JSON.stringify(r)) + ' ' + JSON.stringify({ e: r.eventos, c: r.cobrancas, p: r.pagos });
}

const webhook = (token, evId, evento, extra = {}) => um(
  `select * from public.api_n8n_pagamento_webhook($1,$2,$3,$4,$5,$6,$7)`,
  [token, evId, evento, extra.pagamento ?? null, extra.link ?? null,
   extra.referencia ?? null, extra.valor ?? null]);

try {
  console.log('\n== Migração 61 — pagamento via Asaas (sandbox) ==\n');

  // =====================================================================
  console.log('-- 0. Pré-61 (o rollback roda tendo a 61 sido aplicada ou não) --\n');
  await c.query(semTx(R61));
  const aclEstadoAntes = await aclDe('api_n8n_estado_pedido');
  const contratadasAntes = (await um(
    `select count(*)::int n from public.tenant_tools where tool_nome='pagamento'`)).n;

  chk('PRÉ-61: `pedido_cobrancas` não existe',
    (await um(`select to_regclass('public.pedido_cobrancas') is null as x`)).x === true);
  chk('PRÉ-61: `estado_pedido` não devolve `pagamento_confirmado`',
    !/pagamento_confirmado/.test((await um(
      `select pg_get_functiondef(p.oid) d from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname='api_n8n_estado_pedido'`)).d));
  chk('PRÉ-61: `tenants` não tem `pagamento_expira_minutos`',
    !(await existeCol('tenants', 'pagamento_expira_minutos')));
  console.log(`     ACL de estado_pedido, pré-61: ${aclEstadoAntes}`);

  // =====================================================================
  console.log('\n-- 1. Aplicar, e o que a aplicação NÃO faz --\n');
  await c.query(semTx(M61));

  chk('`pedido_cobrancas` e `pagamento_eventos` existem',
    (await um(`select to_regclass('public.pedido_cobrancas') is not null
                  and to_regclass('public.pagamento_eventos') is not null as x`)).x === true);
  chk('a tool `pagamento` entrou no CATÁLOGO',
    (await um(`select count(*)::int n from public.catalogo_tools where tool_nome='pagamento'`)).n === 1);

  // PROPRIEDADE, não estado do mundo: a migração não contrata para ninguém.
  // Contado antes x depois em vez de afirmado como "zero".
  const contratadasDepois = (await um(
    `select count(*)::int n from public.tenant_tools where tool_nome='pagamento'`)).n;
  chk(`aplicar NÃO contrata para ninguém (${contratadasAntes} antes, ${contratadasDepois} depois)`,
    contratadasDepois === contratadasAntes, `${contratadasAntes} -> ${contratadasDepois}`);

  chk('`pagamento_expira_minutos` nasce em 30 e é agência-only pela lista branca do guard',
    (await um(`select pagamento_expira_minutos from public.tenants limit 1`)).pagamento_expira_minutos === 30
    && !/pagamento_expira_minutos/.test((await um(
      `select pg_get_functiondef(p.oid) d from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname='tenants_guard_colunas'`)).d));

  // =====================================================================
  console.log('\n-- 2. Ambiente: a URL é DERIVADA e só o token ativo autentica --\n');
  TA = await tenantComPagamento('a', TOKEN_A);
  TB = await tenantComPagamento('b', TOKEN_B);

  {
    const cr = await um(`select * from public.api_n8n_credencial_asaas($1)`, [TA]);
    chk('sandbox -> host de sandbox e chave de sandbox',
      cr.base_url === 'https://api-sandbox.asaas.com' && cr.api_key === 'sk_sandbox_a',
      `${cr.base_url} / ${cr.api_key}`);
    chk('e a tool aparece ativa (contratada + ativa)', cr.ativa === true);
  }
  await c.query(`update public.tenant_credenciais set asaas_ambiente='producao' where tenant_id=$1`, [TA]);
  {
    const cr = await um(`select * from public.api_n8n_credencial_asaas($1)`, [TA]);
    chk('produção -> host de produção e chave de produção, juntos',
      cr.base_url === 'https://api.asaas.com' && cr.api_key === 'sk_prod_a',
      `${cr.base_url} / ${cr.api_key}`);
    // A propriedade: NÃO EXISTE o par misto. Não há coluna de URL para
    // discordar da chave — ela sai do ambiente.
    chk('não existe coluna de URL para divergir da chave',
      !(await existeCol('tenant_credenciais', 'asaas_base_url'))
      && !(await existeCol('tenant_credenciais', 'asaas_url')));
    const w = await webhook(TOKEN_A, 'evt_amb_1', 'PAYMENT_RECEIVED');
    chk('o token de SANDBOX deixa de autenticar quando o tenant vira produção',
      w.reconhecido === false && w.motivo === 'token_desconhecido', w.motivo);
  }
  await c.query(`update public.tenant_credenciais set asaas_ambiente='sandbox' where tenant_id=$1`, [TA]);
  chk('e volta a autenticar quando o ambiente volta',
    (await webhook(TOKEN_A, 'evt_amb_2', 'PAYMENT_RECEIVED')).reconhecido === true);

  // =====================================================================
  console.log('\n-- 3. Gerar link: o valor vem do BANCO, e não há parâmetro de valor --\n');
  {
    const args = (await um(
      `select pg_get_function_identity_arguments(p.oid) a from pg_proc p
         join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname='api_n8n_gerar_cobranca'`)).a;
    chk('`api_n8n_gerar_cobranca(uuid, bigint)` — sem valor, sem produto, sem nome',
      args === 'p_tenant_id uuid, p_conversation_id bigint', args);
  }

  {
    const r = await um(`select * from public.api_n8n_gerar_cobranca($1, $2)`, [TA, CONV_A]);
    chk('sem pedido fechado -> recusa com motivo próprio',
      r.ok === false && r.motivo === 'sem_pedido_fechado', r.motivo);
  }

  const PED_A = await pedidoFechado(TA, CONV_A, 6990);
  chk('o pedido fechado tem total 6990 vindo do trigger, não de mim',
    (await um(`select total_centavos from public.pedidos where id=$1`, [PED_A])).total_centavos === 6990);

  let cobrancaA = null;
  {
    const r = await um(`select * from public.api_n8n_gerar_cobranca($1, $2)`, [TA, CONV_A]);
    cobrancaA = r.cobranca_id;
    chk('gera a cobrança', r.ok === true && r.motivo === 'ok', `${r.ok}/${r.motivo}`);
    chk('com o valor do BANCO (6990), não de parâmetro', r.valor_centavos === 6990, `${r.valor_centavos}`);
    chk('a referência externa é o id da cobrança (o webhook volta por ela)',
      r.referencia_externa === r.cobranca_id);
    chk('a credencial viaja junto (é o único caminho até a chave)', r.api_key === 'sk_sandbox_a');
    chk('`vence_em` é DATA — `endDate` do Asaas não tem hora, e isso está medido',
      r.vence_em instanceof Date || /^\d{4}-\d{2}-\d{2}$/.test(String(r.vence_em)), String(r.vence_em));
    chk('a descrição NÃO carrega dado do cliente (a página do Asaas é pública)',
      /^Pedido nº \d+/.test(r.descricao) && !/tel|whats|\+55/i.test(r.descricao), r.descricao);
    const minutos = Math.round((new Date(r.expira_em) - new Date()) / 60000);
    chk('a janela sai de `pagamento_expira_minutos` (30 por padrão)',
      minutos >= 29 && minutos <= 30, `${minutos} min`);
  }

  await c.query(`select public.api_n8n_registrar_cobranca($1,$2,true,$3,$4)`,
    [TA, cobrancaA, 'pl_teste_a', 'https://sandbox.asaas.com/c/aaa']);

  // -----------------------------------------------------------------------
  console.log('\n-- 3b. O piso de R$ 5,00 chega como MOTIVO, nunca como erro --\n');
  {
    // Dois pães de queijo do `emporio` dão R$ 3,00, e o Asaas recusa Pix e
    // boleto abaixo de R$ 5,00 — medido pela recusa do sandbox, não lido em doc.
    const ped = await pedidoFechado(TA, 990010, 300);
    const r = await um(`select * from public.api_n8n_gerar_cobranca($1,$2)`, [TA, 990010]);
    chk('pedido de R$ 3,00 -> recusa com `abaixo_do_minimo`',
      r.ok === false && r.motivo === 'abaixo_do_minimo', `${r.ok}/${r.motivo}`);
    chk('e diz QUANTO é o piso e QUANTO falta (o modelo sabe tratar isso)',
      r.minimo_centavos === 500 && r.faltam_centavos === 200,
      `minimo=${r.minimo_centavos} faltam=${r.faltam_centavos}`);
    chk('nenhuma cobrança foi criada para ele',
      (await um(`select count(*)::int n from public.pedido_cobrancas
                  where tenant_id=$1 and pedido_id=$2`, [TA, ped])).n === 0);
    chk('e a chave NÃO viaja numa recusa', r.api_key === null, String(r.api_key));

    // O ESPELHO: um centavo acima do piso passa. Sem ele, tudo acima passaria
    // numa implementação que recusa qualquer valor.
    const ped2 = await pedidoFechado(TA, 990011, 500);
    const r2 = await um(`select * from public.api_n8n_gerar_cobranca($1,$2)`, [TA, 990011]);
    chk('ESPELHO: exatamente R$ 5,00 (o piso) PASSA',
      r2.ok === true && r2.motivo === 'ok', `${r2.ok}/${r2.motivo}`);
    void ped2;

    // AGÊNCIA-ONLY, MEDIDO E NÃO DEDUZIDO. A primeira versão deste bloco tentou
    // mudar o piso sem claim nenhum e levou `42501` do
    // `trg_tenants_guard_colunas` — o teste ficou vermelho porque a proteção
    // funcionou. Agora ele afirma os DOIS lados.
    {
      await c.query('savepoint sp_guard');
      let err = null;
      try {
        await c.query(`update public.tenants set pagamento_minimo_centavos = 100 where id=$1`, [TA]);
      } catch (e) { err = e; }
      await c.query('rollback to savepoint sp_guard');
      chk('sem ser super_admin, mudar o piso é RECUSADO (42501)',
        err !== null && err.code === '42501', err ? err.code : '(passou!)');
    }

    // E o piso é CONFIGURAÇÃO: a agência muda e a resposta muda, sem deploy. É o
    // que separa uma coluna de uma constante no código — a lição do `S = 622`.
    await c.query('savepoint sp_piso');
    await c.query(`select set_config('request.jwt.claims',
      '{"app_metadata":{"papel":"super_admin"}}', true)`);
    await c.query(`update public.tenants set pagamento_minimo_centavos = 100 where id=$1`, [TA]);
    chk('a mutação ENTROU (o piso está 100)',
      (await um(`select pagamento_minimo_centavos m from public.tenants where id=$1`, [TA])).m === 100);
    const r3 = await um(`select * from public.api_n8n_gerar_cobranca($1,$2)`, [TA, 990010]);
    chk('baixando o piso para R$ 1,00, o MESMO pedido de R$ 3,00 passa',
      r3.ok === true, `${r3.motivo}`);
    await c.query('rollback to savepoint sp_piso');
    chk('e o piso volta a 500 depois do savepoint',
      (await um(`select pagamento_minimo_centavos m from public.tenants where id=$1`, [TA])).m === 500);
  }

  {
    // REUSO: a segunda chamada não pode criar um segundo link vivo.
    const antes = (await um(`select count(*)::int n from public.pedido_cobrancas where tenant_id=$1`, [TA])).n;
    const r = await um(`select * from public.api_n8n_gerar_cobranca($1, $2)`, [TA, CONV_A]);
    const depois = (await um(`select count(*)::int n from public.pedido_cobrancas where tenant_id=$1`, [TA])).n;
    chk('chamar de novo REUSA o link vivo em vez de criar outro',
      r.ja_existia === true && r.cobranca_id === cobrancaA && depois === antes,
      `${antes} -> ${depois}`);
    chk('e devolve a URL que já existe', r.url === 'https://sandbox.asaas.com/c/aaa', r.url);
  }

  // =====================================================================
  console.log('\n-- 4. NENHUMA função deixa o agente marcar `pago` --\n');
  {
    // A propriedade, e não a lista: varre TODA `api_n8n_*` procurando escrita de
    // `status = 'pago'`. Se alguém acrescentar uma função dessas amanhã, este
    // teste a encontra sem precisar ser atualizado.
    // `SET status = 'pago'`, e não `status = 'pago'`: a primeira versão deste
    // varredor procurava a COMPARAÇÃO e achava três funções — duas delas apenas
    // LEEM o status (`where p.status = 'pago'`). Asserção que confunde leitura
    // com escrita não mede o que promete, e teria ficado vermelha para sempre
    // por um motivo que não é defeito.
    const escrevem = await tudo(
      `select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname like 'api\\_n8n\\_%'
          and p.prosrc ~* $$set\\s+status\\s*=\\s*'pago'$$`);
    const nomes = escrevem.map((r) => r.proname).sort();
    chk('só `api_n8n_pagamento_webhook` escreve `status = pago`',
      nomes.length === 1 && nomes[0] === 'api_n8n_pagamento_webhook', nomes.join(', '));
    chk('e ela exige o token do webhook (que o modelo não tem)',
      /p_webhook_token/.test((await um(
        `select pg_get_function_identity_arguments(p.oid) a from pg_proc p
           join pg_namespace n on n.oid=p.pronamespace
          where n.nspname='public' and p.proname='api_n8n_pagamento_webhook'`)).a));
  }

  // =====================================================================
  console.log('\n-- 5. O webhook aplica (o caminho positivo existe) --\n');
  const retratoAntes = await retrato(TA);
  let evAplicou = null;
  {
    const r = await webhook(TOKEN_A, 'evt_pago_1', 'PAYMENT_RECEIVED',
      { pagamento: 'pay_a1', link: 'pl_teste_a', referencia: cobrancaA, valor: 6990 });
    evAplicou = r;
    chk('reconhecido, não duplicado, APLICOU',
      r.reconhecido === true && r.ja_processado === false && r.aplicou === true, r.motivo);
    chk('o pedido virou `pago`',
      (await um(`select status from public.pedidos where id=$1`, [PED_A])).status === 'pago');
    chk('a cobrança recebeu `pago_em` e o id do pagamento',
      (await um(`select pago_em is not null and pagamento_id='pay_a1' as x
                   from public.pedido_cobrancas where id=$1`, [cobrancaA])).x === true);
    chk('a mensagem ao cliente é escrita em CÓDIGO, com o valor do banco',
      /Pagamento confirmado/.test(r.mensagem) && /R\$ 69,90/.test(r.mensagem), r.mensagem);
    chk('e ela carrega o número do pedido', /nº \d+/.test(r.mensagem), r.mensagem);
    chk('o evento ficou registrado como aplicado',
      (await um(`select aplicou, motivo from public.pagamento_eventos
                  where tenant_id=$1 and evento_id='evt_pago_1'`, [TA])).aplicou === true);
    chk('e o registro NÃO guarda payload cru (nada de PII do pagador)',
      !(await existeCol('pagamento_eventos', 'payload')));
  }

  // =====================================================================
  console.log('\n-- 6. IDEMPOTÊNCIA camada 1: o MESMO evento reenviado --\n');
  {
    const antes = await retrato(TA);
    const r = await webhook(TOKEN_A, 'evt_pago_1', 'PAYMENT_RECEIVED',
      { pagamento: 'pay_a1', link: 'pl_teste_a', referencia: cobrancaA, valor: 6990 });
    const depois = await retrato(TA);
    chk('a segunda vez devolve `ja_processado` e NÃO aplica',
      r.ja_processado === true && r.aplicou === false, r.motivo);
    // O ESTADO DO BANCO, não só a resposta.
    chk('e o ESTADO DO BANCO é idêntico (md5 do retrato)', antes === depois,
      `\n      antes:  ${antes}\n      depois: ${depois}`);
    chk('não há segunda notificação (sem mensagem quando não aplicou)',
      r.mensagem === null, String(r.mensagem));
  }

  // =====================================================================
  console.log('\n-- 7. IDEMPOTÊNCIA camada 2: evento DIFERENTE, mesmo pagamento --\n');
  {
    // `PAYMENT_CONFIRMED` depois de `PAYMENT_RECEIVED` tem outro `id`, então
    // passa direto pela camada 1. Quem o segura é o estado.
    const antesPagos = (await um(
      `select count(*)::int n from public.pedidos where tenant_id=$1 and status='pago'`, [TA])).n;
    const pagoEmAntes = (await um(
      `select pago_em from public.pedido_cobrancas where id=$1`, [cobrancaA])).pago_em;
    const r = await webhook(TOKEN_A, 'evt_pago_2_OUTRO_ID', 'PAYMENT_CONFIRMED',
      { pagamento: 'pay_a1', link: 'pl_teste_a', referencia: cobrancaA, valor: 6990 });
    chk('ele NÃO é duplicado por evento (o id é outro)', r.ja_processado === false);
    chk('mas NÃO aplica de novo — a camada 2 o segura',
      r.aplicou === false && r.motivo === 'ja_pago', r.motivo);
    chk('e `pago_em` não foi reescrito',
      String((await um(`select pago_em from public.pedido_cobrancas where id=$1`, [cobrancaA])).pago_em)
      === String(pagoEmAntes));
    chk('nem apareceu um segundo pedido pago',
      (await um(`select count(*)::int n from public.pedidos where tenant_id=$1 and status='pago'`, [TA])).n
      === antesPagos);
    chk('sem segunda mensagem', r.mensagem === null);
  }

  // =====================================================================
  console.log('\n-- 8. FORA DO PRAZO: não aplica, não reabre, vira caso humano --\n');
  {
    const ped = await pedidoFechado(TA, 990003, 12345);
    const r0 = await um(`select * from public.api_n8n_gerar_cobranca($1, $2)`, [TA, 990003]);
    await c.query(`select public.api_n8n_registrar_cobranca($1,$2,true,$3,$4)`,
      [TA, r0.cobranca_id, 'pl_tarde', 'https://sandbox.asaas.com/c/tarde']);
    // A janela fecha. É a NOSSA autoridade sobre o prazo, com precisão de
    // segundo — o `endDate` do Asaas nem chegaria a este caso.
    await c.query(`update public.pedido_cobrancas set expira_em = now() - interval '1 minute'
                    where id=$1`, [r0.cobranca_id]);

    const r = await webhook(TOKEN_A, 'evt_tarde', 'PAYMENT_RECEIVED',
      { pagamento: 'pay_tarde', referencia: r0.cobranca_id, valor: 12345 });
    chk('reconhecido, mas NÃO aplicado', r.reconhecido === true && r.aplicou === false, r.motivo);
    chk('o motivo é `fora_do_prazo`', r.motivo === 'fora_do_prazo', r.motivo);
    chk('e ele pede humano', r.precisa_humano === true);
    chk('O PEDIDO NÃO REABRE nem vira pago',
      (await um(`select status from public.pedidos where id=$1`, [ped])).status === 'aguardando_pagamento',
      (await um(`select status from public.pedidos where id=$1`, [ped])).status);
    chk('a divergência fica registrada na cobrança (com o id do pagamento retido)',
      (await um(`select fora_do_prazo_em is not null and pago_em is null and pagamento_id='pay_tarde' as x
                   from public.pedido_cobrancas where id=$1`, [r0.cobranca_id])).x === true);
    chk('e nenhuma mensagem automática vai ao cliente', r.mensagem === null);
  }

  // =====================================================================
  console.log('\n-- 9. Isolamento entre tenants --\n');
  {
    const pedB = await pedidoFechado(TB, CONV_B, 5000);
    const rb = await um(`select * from public.api_n8n_gerar_cobranca($1, $2)`, [TB, CONV_B]);
    await c.query(`select public.api_n8n_registrar_cobranca($1,$2,true,$3,$4)`,
      [TB, rb.cobranca_id, 'pl_teste_b', 'https://sandbox.asaas.com/c/bbb']);

    // CONTRAPROVA: a cobrança do B existe mesmo (senão o "não alcança" abaixo
    // seria verdadeiro por vacuidade).
    chk('CONTRAPROVA: o tenant B tem uma cobrança viva',
      (await um(`select count(*)::int n from public.pedido_cobrancas where tenant_id=$1`, [TB])).n === 1);

    const r = await webhook(TOKEN_A, 'evt_cruzado', 'PAYMENT_RECEIVED',
      { pagamento: 'pay_b1', link: 'pl_teste_b', referencia: rb.cobranca_id, valor: 5000 });
    chk('o token do A NÃO alcança a cobrança do B',
      r.tenant_id === TA && r.aplicou === false && r.motivo === 'cobranca_desconhecida', r.motivo);
    chk('e o pedido do B continua aguardando',
      (await um(`select status from public.pedidos where id=$1`, [pedB])).status === 'aguardando_pagamento');

    const g = await um(`select * from public.api_n8n_gerar_cobranca($1, $2)`, [TA, CONV_B]);
    chk('e o A não gera cobrança para a conversa do B', g.ok === false, g.motivo);
  }

  // =====================================================================
  console.log('\n-- 10. RLS das tabelas novas, com contraprova --\n');
  {
    // CONTRAPROVA primeiro: existem linhas para ler. Sem isto, tudo abaixo é
    // verdadeiro por vacuidade — passa com RLS ligada e com ela desligada.
    const totalA = (await um(
      `select count(*)::int n from public.pedido_cobrancas where tenant_id=$1`, [TA])).n;
    const totalB = (await um(
      `select count(*)::int n from public.pedido_cobrancas where tenant_id=$1`, [TB])).n;
    chk('CONTRAPROVA: os DOIS tenants têm cobrança gravada',
      totalA > 0 && totalB > 0, `A=${totalA} B=${totalB}`);

    // `anon` é RECUSADO no grant, antes de a RLS opinar — mais forte que "lê 0
    // linhas", e é o que o `revoke all` da migração compra. Rejeição esperada
    // vira asserção, não crash.
    for (const t of ['pedido_cobrancas', 'pagamento_eventos']) {
      await c.query('savepoint sp_anon');
      let err = null;
      try {
        await c.query('set local role anon');
        await c.query(`select count(*) from public.${t}`);
      } catch (e) { err = e; }
      await c.query('rollback to savepoint sp_anon');
      chk(`\`anon\` é RECUSADO em ${t} (42501, no grant — antes da RLS)`,
        err !== null && err.code === '42501', err ? err.code : '(leu sem erro!)');
    }

    // E a RLS, medida onde ela de fato trabalha: `authenticated` com o claim do
    // tenant A vê o A e NÃO vê o B.
    await c.query('savepoint sp_auth');
    await c.query(`select set_config('request.jwt.claims',
      json_build_object('app_metadata', json_build_object('tenant_id', $1::text))::text, true)`, [TA]);
    await c.query('set local role authenticated');
    const vA = (await um(`select count(*)::int n from public.pedido_cobrancas where tenant_id=$1`, [TA])).n;
    const vB = (await um(`select count(*)::int n from public.pedido_cobrancas where tenant_id=$1`, [TB])).n;
    const eB = (await um(`select count(*)::int n from public.pagamento_eventos where tenant_id=$1`, [TB])).n;
    await c.query('rollback to savepoint sp_auth');
    chk('`authenticated` do tenant A vê as cobranças do A', vA === totalA, `${vA} de ${totalA}`);
    chk('e vê ZERO das do B, que existem', vB === 0 && totalB > 0, `${vB} (B tem ${totalB})`);
    chk('e zero dos eventos de pagamento do B', eB === 0, `${eB}`);

    for (const t of ['pedido_cobrancas', 'pagamento_eventos']) {
      const acl = (await um(
        `select coalesce(c.relacl::text,'(NULO)') a from pg_class c
           join pg_namespace n on n.oid=c.relnamespace
          where n.nspname='public' and c.relname=$1`, [t])).a;
      chk(`${t}: \`anon\` não tem grant, e \`authenticated\` só lê`,
        !/anon=/.test(acl) && /authenticated=r\//.test(acl), acl);
      chk(`${t}: RLS ativo com policy`,
        (await um(`select relrowsecurity from pg_class where oid=('public.'||$1)::regclass`, [t])).relrowsecurity === true
        && (await um(`select count(*)::int n from pg_policy where polrelid=('public.'||$1)::regclass`, [t])).n > 0);
    }
  }

  // =====================================================================
  console.log('\n-- 11. ACL das funções: diff, e chamada real --\n');
  {
    const aclEstadoDepois = await aclDe('api_n8n_estado_pedido');
    // O `drop function` apagou TUDO. O que prova que foi reposto certo é o DIFF
    // contra o de antes — não a lista que eu escrevi (foi assim que a 41 passou
    // verde sem `n8n_agent`).
    chk('o ACL de `estado_pedido` sobreviveu ao `drop` IDÊNTICO',
      aclEstadoDepois === aclEstadoAntes,
      `\n      antes:  ${aclEstadoAntes}\n      depois: ${aclEstadoDepois}`);

    const novas = ['api_n8n_credencial_asaas', 'api_n8n_gerar_cobranca',
      'api_n8n_registrar_cobranca', 'api_n8n_pagamento_webhook',
      'api_n8n_confirmar_pagamento_notificado'];
    for (const f of novas) {
      const acl = await aclDe(f);
      chk(`${f}: n8n_agent e service_role sim, anon e authenticated não`,
        /n8n_agent=X/.test(acl) && /service_role=X/.test(acl)
        && !/\banon=X/.test(acl) && !/\bauthenticated=X/.test(acl), acl);
    }

    // Ter grant e conseguir chamar são medidas diferentes (CLAUDE.md, nota da
    // 54) — e nem chamar basta, porque a função ESCANCARADA também deixa chamar.
    await c.query('savepoint sp_role');
    await c.query('set local role n8n_agent');
    const e = await um(`select * from public.api_n8n_estado_pedido($1, $2)`, [TA, CONV_A]);
    const w = await um(`select reconhecido from public.api_n8n_pagamento_webhook($1,$2,$3)`,
      [TOKEN_A, 'evt_role', 'PAYMENT_RECEIVED']);
    await c.query('rollback to savepoint sp_role');
    chk('n8n_agent CHAMA `estado_pedido` e recebe `pagamento_confirmado`',
      e.pagamento_confirmado === true, JSON.stringify(e.pagamento_confirmado));
    chk('n8n_agent CHAMA o webhook', w.reconhecido === true);
  }

  // =====================================================================
  console.log('\n-- 12. `pagamento_confirmado` é do pedido MAIS RECENTE --\n');
  {
    const e1 = await um(`select * from public.api_n8n_estado_pedido($1, $2)`, [TA, CONV_A]);
    chk('com o pedido pago, `pagamento_confirmado` é verdadeiro', e1.pagamento_confirmado === true);

    // Carrinho novo depois de pagar: o pagamento de ontem não vale para o de
    // hoje. Sem isso, a regra 3 do portão passaria a autorizar afirmação de
    // pagamento pelo resto da conversa.
    await c.query(`insert into public.pedidos (tenant_id, conversation_id, status)
                   values ($1, $2, 'rascunho')`, [TA, CONV_A]);
    const e2 = await um(`select * from public.api_n8n_estado_pedido($1, $2)`, [TA, CONV_A]);
    chk('carrinho NOVO depois de pagar -> `pagamento_confirmado` volta a ser falso',
      e2.pagamento_confirmado === false, String(e2.pagamento_confirmado));
  }

  // =====================================================================
  console.log('\n-- 13. Gerar o link conta como escrita do turno --\n');
  {
    // É o que impede a regra 1 do portão de barrar a mensagem que ENTREGA o
    // link. Medido aqui, no banco, e não só no JS do portão.
    const ped = await pedidoFechado(TB, 990004, 4000);
    // ENVELHECER UM PEDIDO EXIGE DESLIGAR OS GATILHOS. `set_atualizado_em` é
    // BEFORE UPDATE e reescreve `atualizado_em` com `now()` — um `update` que
    // tenta recuar a data não recua nada, e o teste mediria a data de hoje
    // achando que mediu a de duas horas atrás.
    await c.query(`set local session_replication_role = replica`);
    await c.query(`update public.pedidos set atualizado_em = now() - interval '2 hours' where id=$1`,
      [ped]);
    await c.query(`update public.pedido_itens set atualizado_em = now() - interval '2 hours'
                    where pedido_id=$1`, [ped]);
    await c.query(`set local session_replication_role = origin`);
    // CONFIRMA QUE A MUTAÇÃO ENTROU antes de acreditar no que vem depois.
    chk('o pedido de fato envelheceu (o gatilho não desfez)',
      (await um(`select atualizado_em < now() - interval '1 hour' as x from public.pedidos where id=$1`,
        [ped])).x === true);
    const antes = await um(`select escreveu_neste_turno from public.api_n8n_estado_pedido($1,$2)`,
      [TB, 990004]);
    const g = await um(`select * from public.api_n8n_gerar_cobranca($1,$2)`, [TB, 990004]);
    const depois = await um(`select escreveu_neste_turno from public.api_n8n_estado_pedido($1,$2)`,
      [TB, 990004]);
    chk('pedido velho: sem escrita no turno', antes.escreveu_neste_turno === false);
    chk('gerou a cobrança agora: PASSA a haver escrita no turno',
      g.ok === true && depois.escreveu_neste_turno === true,
      `${g.motivo} / ${depois.escreveu_neste_turno}`);
  }

  // =====================================================================
  console.log('\n-- 14. O rollback ABORTA quando há pagamento registrado --\n');
  {
    await c.query('savepoint sp_rb');
    let erro = null;
    try { await c.query(semTx(R61)); } catch (e) { erro = e; }
    await c.query('rollback to savepoint sp_rb');
    // Rejeição esperada vira ASSERÇÃO, não crash.
    chk('com cobrança paga, o rollback recusa com mensagem própria',
      erro !== null && /ABORTADO/.test(erro.message) && /prova de que aquele dinheiro entrou/.test(erro.message),
      erro ? erro.message.slice(0, 120) : '(não abortou)');
  }
  {
    // E o espelho: sem pagamento e sem contratação, ele roda. Só a §14 sozinha
    // passaria numa implementação que aborta sempre.
    await c.query('savepoint sp_rb2');
    await c.query(`update public.pedido_cobrancas set pago_em=null, fora_do_prazo_em=null,
                     pagamento_id=null where tenant_id in ($1,$2)`, [TA, TB]);
    await c.query(`delete from public.tenant_tools where tool_nome='pagamento'`);
    let erro2 = null;
    try { await c.query(semTx(R61)); } catch (e) { erro2 = e; }
    chk('sem pagamento e sem contratação, o rollback RODA',
      erro2 === null, erro2 ? `${erro2.code} ${erro2.message}` : '');
    chk('e `pedido_cobrancas` some',
      (await um(`select to_regclass('public.pedido_cobrancas') is null as x`)).x === true);
    // TODAS as colunas, não só a que eu lembrei. Rollback que deixa coluna para
    // trás é o mesmo estado meio-aplicado que ele existe para desfazer.
    for (const col of ['pagamento_expira_minutos', 'pagamento_minimo_centavos']) {
      chk(`e \`tenants.${col}\` some`, !(await existeCol('tenants', col)));
    }
    for (const col of ['asaas_ambiente', 'asaas_api_key_sandbox', 'asaas_api_key_producao',
      'asaas_webhook_token_sandbox', 'asaas_webhook_token_producao']) {
      chk(`e \`tenant_credenciais.${col}\` some`, !(await existeCol('tenant_credenciais', col)));
    }
    chk('e o ACL de `estado_pedido` volta ao de antes (o rollback também reconcede)',
      (await aclDe('api_n8n_estado_pedido')) === aclEstadoAntes,
      `${aclEstadoAntes} -> ${await aclDe('api_n8n_estado_pedido')}`);
    await c.query('rollback to savepoint sp_rb2');
  }

  // =====================================================================
  console.log('\n-- 15. SABOTAGEM --\n');
  const sabotar = (de, para, rotulo) => {
    const n = M61.split(de).length - 1;
    if (n !== 1) {
      falhas.push(`sabotagem "${rotulo}" não localizou o alvo`);
      console.log(`  FALHA sabotagem "${rotulo}" casa ${n}x, esperava 1`);
      return null;
    }
    const mut = M61.split(de).join(para);
    if (mut === M61) {
      falhas.push(`sabotagem "${rotulo}" não mutou`);
      console.log(`  FALHA sabotagem "${rotulo}" não mudou o texto`);
      return null;
    }
    console.log(`     [mutou "${rotulo}": md5 ${md5(M61)} -> ${md5(mut)}]`);
    return semTx(mut);
  };
  // Cada sabotagem parte do PRÉ-61: rollback, aplica a versão mutada, mede.
  //
  // O ARRANJO ANTES DO ROLLBACK NÃO É DETALHE. O rollback da 61 ABORTA quando
  // há cobrança paga ou tool contratada — e as seções acima criaram as duas
  // coisas. Sem neutralizá-las, TODA sabotagem morre no `raise` do rollback e
  // reporta "não pegou" quando na verdade nem chegou a rodar: o falso vermelho
  // gêmeo do falso verde. É o mesmo corolário do `tests/lib/pedidos-vivos-55`:
  // o teste ARRANJA o estado pré-migração em vez de torcer para ele existir.
  const sob = async (sql, fn) => {
    await c.query('savepoint sab');
    try {
      await c.query(`update public.pedido_cobrancas
                        set pago_em = null, fora_do_prazo_em = null, pagamento_id = null`);
      await c.query(`delete from public.tenant_tools where tool_nome = 'pagamento'`);
      await c.query(semTx(R61));
      await c.query(sql);
      return await fn();
    } catch (e) {
      return { erro: `${e.code} ${e.message}` };
    } finally {
      await c.query('rollback to savepoint sab');
    }
  };

  // S1 — tirar a unique de evento: a camada 1 morre e o reenvio duplica.
  {
    const s = sabotar(
      'create unique index if not exists uq_pagamento_eventos_evento\n  on public.pagamento_eventos (tenant_id, evento_id);',
      'create index if not exists uq_pagamento_eventos_evento\n  on public.pagamento_eventos (tenant_id, evento_id);',
      'unique de evento removida');
    if (s) {
      const r = await sob(s, async () => {
        const t = await tenantComPagamento('s1', TOKEN_A);
        await pedidoFechado(t, 991001, 1000);
        const g = await um(`select * from public.api_n8n_gerar_cobranca($1,$2)`, [t, 991001]);
        await c.query(`select public.api_n8n_registrar_cobranca($1,$2,true,'pl_s1','u')`, [t, g.cobranca_id]);
        await webhook(TOKEN_A, 'evt_dup', 'PAYMENT_RECEIVED', { referencia: g.cobranca_id, valor: 1000 });
        const seg = await webhook(TOKEN_A, 'evt_dup', 'PAYMENT_RECEIVED', { referencia: g.cobranca_id, valor: 1000 });
        const n = (await um(`select count(*)::int n from public.pagamento_eventos where tenant_id=$1`, [t])).n;
        return { seg, n };
      });
      // MEDIDO, e o resultado é mais forte do que eu tinha escrito: sem o
      // índice, o `on conflict (tenant_id, evento_id)` não tem em que se
      // apoiar e o Postgres recusa com `42P10` — ou seja, TODO webhook passa a
      // falhar, não só o duplicado. O índice não é uma otimização da
      // idempotência: é a peça que a faz existir.
      chk('S1 sem a unique -> o `on conflict` perde o apoio e TODO webhook falha (42P10)',
        String(r.erro).startsWith('42P10'), r.erro ?? `n=${r.n}`);
    }
  }

  // S2 — tirar a guarda de estado do update de `pedidos`: a camada 2 morre e
  //      o par CONFIRMED/RECEIVED aplica duas vezes.
  {
    const s = sabotar("           and p.status = 'aguardando_pagamento'\n", '',
      'guarda de estado no update de pedidos');
    if (s) {
      const r = await sob(s, async () => {
        const t = await tenantComPagamento('s2', TOKEN_A);
        await pedidoFechado(t, 991002, 1000);
        const g = await um(`select * from public.api_n8n_gerar_cobranca($1,$2)`, [t, 991002]);
        await c.query(`select public.api_n8n_registrar_cobranca($1,$2,true,'pl_s2','u')`, [t, g.cobranca_id]);
        await webhook(TOKEN_A, 'evt_r', 'PAYMENT_RECEIVED', { referencia: g.cobranca_id, valor: 1000 });
        // Segundo evento, id diferente, e a cobranca ja tem pago_em -> so o
        // update de `pedidos` distingue. Forco `pago_em` nulo para isolar a
        // guarda que estou medindo, e nao a outra.
        await c.query(`update public.pedido_cobrancas set pago_em=null where id=$1`, [g.cobranca_id]);
        return await webhook(TOKEN_A, 'evt_c', 'PAYMENT_CONFIRMED', { referencia: g.cobranca_id, valor: 1000 });
      });
      chk('S2 sem a guarda de estado -> o segundo evento APLICA de novo (e notifica de novo)',
        !r.erro && r.aplicou === true && r.mensagem !== null, r.erro ?? `${r.motivo}`);
    }
  }

  // S3 — deixar o webhook aceitar o token de QUALQUER ambiente.
  {
    const s = sabotar(
      "  where (tc.asaas_ambiente = 'sandbox'\n         and tc.asaas_webhook_token_sandbox = btrim(p_webhook_token))\n     or (tc.asaas_ambiente = 'producao'\n         and tc.asaas_webhook_token_producao = btrim(p_webhook_token));",
      '  where tc.asaas_webhook_token_sandbox = btrim(p_webhook_token)\n     or tc.asaas_webhook_token_producao = btrim(p_webhook_token);',
      'token de qualquer ambiente autentica');
    if (s) {
      const r = await sob(s, async () => {
        const t = await tenantComPagamento('s3', TOKEN_A);
        await c.query(`update public.tenant_credenciais set asaas_ambiente='producao' where tenant_id=$1`, [t]);
        return await webhook(TOKEN_A, 'evt_s3', 'PAYMENT_RECEIVED');
      });
      chk('S3 -> o token de sandbox volta a autenticar tenant em PRODUÇÃO',
        !r.erro && r.reconhecido === true, r.erro ?? String(r.reconhecido));
    }
  }

  // S4 — tirar `pedido_cobrancas` do `escreveu_neste_turno`: a mensagem que
  //      entrega o link volta a cair na regra 1 do portão.
  {
    const s = sabotar(
      '           coalesce((select max(c.atualizado_em)\n                       from public.pedido_cobrancas c\n                      where c.pedido_id = p.id\n                        and c.tenant_id = p_tenant_id), p.atualizado_em)\n',
      '           p.atualizado_em\n',
      'cobranca fora do escreveu_neste_turno');
    if (s) {
      const r = await sob(s, async () => {
        const t = await tenantComPagamento('s4', TOKEN_A);
        const ped = await pedidoFechado(t, 991004, 1000);
        // Mesmo `session_replication_role` da §13: sem ele o BEFORE UPDATE
        // desfaz o envelhecimento e a sabotagem mediria um pedido de agora —
        // e reportaria "não pegou" sem nunca ter arranjado o caso.
        await c.query(`set local session_replication_role = replica`);
        await c.query(`update public.pedidos set atualizado_em = now() - interval '2 hours' where id=$1`, [ped]);
        await c.query(`update public.pedido_itens set atualizado_em = now() - interval '2 hours' where pedido_id=$1`, [ped]);
        await c.query(`set local session_replication_role = origin`);
        await um(`select * from public.api_n8n_gerar_cobranca($1,$2)`, [t, 991004]);
        return await um(`select escreveu_neste_turno from public.api_n8n_estado_pedido($1,$2)`, [t, 991004]);
      });
      chk('S4 -> gerar o link deixa de contar como escrita do turno',
        !r.erro && r.escreveu_neste_turno === false, r.erro ?? String(r.escreveu_neste_turno));
    }
  }

  // S5 — tirar os dois `grant` de `estado_pedido` depois do `drop`. E a
  //      armadilha das migracoes 40/41, e o que a pega e o DIFF do ACL.
  {
    const s = sabotar(
      'grant execute on function public.api_n8n_estado_pedido(uuid, bigint, text, integer) to service_role;\ngrant execute on function public.api_n8n_estado_pedido(uuid, bigint, text, integer) to n8n_agent;',
      '-- grants esquecidos',
      'grants de estado_pedido esquecidos');
    if (s) {
      const r = await sob(s, async () => ({ acl: await aclDe('api_n8n_estado_pedido') }));
      chk('S5 sem os grants -> o ACL DIVERGE do de antes (o diff é quem pega)',
        !r.erro && r.acl !== aclEstadoAntes, r.erro ?? `${r.acl}`);
    }
  }
} catch (err) {
  falhas.push('exceção');
  console.log(`\n  EXCEÇÃO: ${err.code ?? ''} ${err.message}`);
} finally {
  await c.query('rollback');
  await c.end();
}

console.log(`\n${'-'.repeat(62)}`);
console.log(`  ${ok} passaram, ${falhas.length} falharam`);
if (falhas.length) { for (const f of falhas) console.log(`    - ${f}`); process.exit(1); }
