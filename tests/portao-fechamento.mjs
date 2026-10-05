/**
 * Migração 79 — o portão enxerga o pedido que ACABOU de ser fechado.
 *
 * REPRODUZ a venda do Douglas (conversa 39 do Empório, 02/10/2026), com os
 * mesmos 224 ms que a quebraram:
 *
 *   t+0ms    `fechar_pedido` -> pedido em `aguardando_pagamento`
 *   t+224ms  a tool registra o ENDEREÇO como saída (migração 72)
 *   t+2s     o portão lê o estado -> via `tem_pedido: false` e barrava a
 *            confirmação da venda, mandando "Ainda nao tenho nenhum item
 *            anotado no seu pedido aqui" a quem tinha acabado de comprar.
 *
 * Rollback-first: o rollback é a versão PRÉ-79, então o teste mede o defeito
 * de verdade antes de medir o conserto. Sem essa contraprova, "tem_pedido é
 * true" seria verdade também num banco onde nada foi corrigido.
 *
 * E deriva a lista do serviço: toda `fonte` que uma TOOL registra em
 * `mensagens_log` tem de estar na exclusão da 79 — tool nova que escreva no
 * meio do turno reprova aqui em vez de reabrir o defeito calada.
 *
 *   npm run teste:portao-fechamento
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(RAIZ, 'supabase', 'migrations');
const leia = (n) => fs.readFileSync(path.join(DIR, n), 'utf8').replace(/\r\n/g, '\n');
const M79 = leia('20261005120000_79_portao_ve_o_fechamento.sql');
const R79 = leia('20261005120000_79_portao_ve_o_fechamento_rollback.sql');
const semTx = (s) => s.replace(/^\s*(begin|commit)\s*;\s*$/gim, '');

let ok = 0;
const falhas = [];
const chk = (nome, cond, det = '') => {
  if (cond) { ok++; console.log(`  OK    ${nome}`); }
  else { falhas.push(nome); console.log(`  FALHA ${nome}${det ? ` — ${det}` : ''}`); }
};
const url = process.env.SUPABASE_DB_URL ?? fs.readFileSync(path.join(RAIZ, '.env.local'), 'utf8')
  .split(/\r?\n/).find((l) => l.startsWith('SUPABASE_DB_URL='))?.slice('SUPABASE_DB_URL='.length).trim().replace(/^["']|["']$/g, '');
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await c.connect();
await c.query('begin');
const um = async (sql, p = []) => (await c.query(sql, p)).rows[0];

/**
 * A cena do fechamento, com os instantes RELATIVOS da conversa 39. Os `update`
 * de `criado_em`/`atualizado_em` existem porque `now()` é constante dentro da
 * transação — sem eles os três eventos teriam o mesmo instante e a ordem que o
 * defeito depende (endereço DEPOIS do pedido) não existiria.
 */
async function cenaDoFechamento(tenantId, conv, produtoId) {
  // `pedidos` e `pedido_itens` têm gatilho que carimba `atualizado_em = now()`
  // — no INSERT e no UPDATE (medido: o valor explícito do insert era
  // sobrescrito). Sem desligá-lo o pedido nasce "agora", entra na janela por
  // conta própria e o defeito desaparece do arranjo. Dentro da transação
  // abortada, desligar é local e some no rollback.
  await c.query(`alter table public.pedidos disable trigger user`);
  await c.query(`alter table public.pedido_itens disable trigger user`);
  const ped = await um(
    `insert into public.pedidos (tenant_id, conversation_id, status, modalidade, total_centavos, numero, criado_em, atualizado_em)
     values ($1, $2, 'aguardando_pagamento', 'retirada', 1500, 6, now() - interval '2 minutes', now() - interval '10 seconds')
     returning id, atualizado_em`, [tenantId, conv]);
  // O ITEM nasce VELHO, no instante do pedido: no caso real ele entrou no
  // `adicionar`, minutos antes do fechamento. Com o default `now()` a
  // referência entrava na janela por outro caminho e o defeito sumia — foi o
  // que aconteceu na primeira execução deste teste. E tem de ser no INSERT:
  // `trg_pedido_itens_upd` reescreve `atualizado_em` em todo update, então
  // envelhecer por update não envelhece nada.
  await c.query(`insert into public.pedido_itens (tenant_id, pedido_id, produto_id, nome_snapshot, quantidade, preco_unit_centavos, criado_em, atualizado_em)
                 values ($1, $2, $3, 'Pão de queijo tradicional', 10, 150, $4, $4)`, [tenantId, ped.id, produtoId, ped.atualizado_em]);
  // a saída do turno ANTERIOR (a pergunta "manhã ou tarde?")
  await c.query(`select public.api_n8n_registrar_mensagem($1, $2, 'saida', 'Douglas, prefere retirar de manha ou a tarde?', 10, 10, 'gpt-4.1-mini', null, $3, $4::jsonb)`,
    [tenantId, conv, `ant-${conv}`, JSON.stringify({ fonte: 'openai_usage', chamadas: 1 })]);
  await c.query(`update public.mensagens_log set criado_em = now() - interval '30 seconds' where tenant_id=$1 and conversation_id=$2 and execucao_id=$3`, [tenantId, conv, `ant-${conv}`]);
  // o ENDEREÇO, escrito pela tool 224 ms DEPOIS de o pedido fechar
  await c.query(`select public.api_n8n_registrar_mensagem($1, $2, 'saida', '📍 Retirada: Av. Sao Paulo, 2680', 0, 0, null, null, $3, $4::jsonb)`,
    [tenantId, conv, `end-${conv}`, JSON.stringify({ fonte: 'endereco_retirada', chamadas: 0 })]);
  await c.query(`update public.mensagens_log set criado_em = $4 where tenant_id=$1 and conversation_id=$2 and execucao_id=$3`,
    [tenantId, conv, `end-${conv}`, new Date(new Date(ped.atualizado_em).getTime() + 224)]);
  await c.query(`alter table public.pedido_itens enable trigger user`);
  await c.query(`alter table public.pedidos enable trigger user`);
  return ped;
}

const estado = async (tenantId, conv) => await um(`select * from public.api_n8n_estado_pedido($1, $2, 'vendas', 300)`, [tenantId, conv]);

try {
  console.log('\n== 0. Arranjo ==\n');
  const T = {};
  for (const s of ['a', 'b']) T[s] = (await um(`insert into public.tenants (slug, nome) values ($1, $2) returning id`, [`z-teste-79-${s}`, `Teste 79 ${s}`])).id;
  const prod = await um(`insert into public.produtos (tenant_id, nome, preco_centavos) values ($1, 'Pão de queijo tradicional', 150) returning id`, [T.a]);
  const aclAntes = (await um(`select p.proacl::text a from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='api_n8n_estado_pedido'`)).a;

  console.log('\n== 1. CONTRAPROVA: com a versão PRÉ-79, o defeito acontece ==\n');
  await c.query(semTx(R79));
  await cenaDoFechamento(T.a, 391, prod.id);
  const antes = await estado(T.a, 391);
  chk('pré-79: o pedido recém-fechado SOME do portão (tem_pedido false, total 0) — é o bug do Douglas',
    antes.tem_pedido === false && Number(antes.total_centavos) === 0 && antes.pedido_status === null, JSON.stringify(antes));
  chk('pré-79: e `escreveu_neste_turno` também é falso, que é o que faz a regra 1 barrar', antes.escreveu_neste_turno === false);

  console.log('\n== 2. A 79, duas vezes ==\n');
  await c.query(semTx(M79)); await c.query(semTx(M79));
  const depois = await estado(T.a, 391);
  chk('a 79 aplica duas vezes e o portão PASSA A VER o pedido fechado',
    depois.tem_pedido === true && depois.pedido_status === 'aguardando_pagamento' && Number(depois.total_centavos) === 1500, JSON.stringify(depois));
  chk('e `escreveu_neste_turno` é verdadeiro — a regra 1 não barra a confirmação da venda', depois.escreveu_neste_turno === true);
  chk('o número do pedido chega ao portão (é o que a frase do cliente cita)', Number(depois.pedido_numero) === 6);
  chk('ACL idêntico ao de antes (create or replace, sem drop)',
    (await um(`select p.proacl::text a from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='api_n8n_estado_pedido'`)).a === aclAntes, aclAntes);

  console.log('\n== 3. O que a 79 NÃO pode ter afrouxado ==\n');
  // Uma saída NORMAL do turno anterior continua fechando a janela: sem isso a
  // regra 1 pararia de barrar fabricação, que é a razão de o portão existir.
  await c.query(`alter table public.pedidos disable trigger user`);
  await um(`insert into public.pedidos (tenant_id, conversation_id, status, modalidade, total_centavos, criado_em, atualizado_em)
            values ($1, 392, 'rascunho', null, 4200, now() - interval '20 minutes', now() - interval '20 minutes') returning id`, [T.a]);
  await c.query(`alter table public.pedidos enable trigger user`);
  await c.query(`select public.api_n8n_registrar_mensagem($1, 392, 'saida', 'posso anotar?', 10, 10, 'gpt-4.1-mini', null, 'norm-392', $2::jsonb)`,
    [T.a, JSON.stringify({ fonte: 'openai_usage', chamadas: 1 })]);
  const semEscrita = await estado(T.a, 392);
  chk('pedido antigo + saída normal recente: `escreveu_neste_turno` FALSO (a regra 1 continua podendo barrar)',
    semEscrita.escreveu_neste_turno === false && semEscrita.tem_pedido === true && semEscrita.pedido_status === 'rascunho', JSON.stringify(semEscrita));
  // O teto de 300 s continua valendo: mutação velha não vira "deste turno".
  await c.query(`delete from public.mensagens_log where tenant_id=$1 and conversation_id=392`, [T.a]);
  chk('sem saída nenhuma, o teto de 300 s ainda corta mutação de 20 min atrás', (await estado(T.a, 392)).escreveu_neste_turno === false);
  // Isolamento: a cena do tenant B não interfere no A.
  await cenaDoFechamento(T.b, 391, prod.id).catch(() => null);
  const aindaA = await estado(T.a, 391);
  chk('a cena do tenant B não muda o estado do A (mesma conversation_id, tenants diferentes)',
    aindaA.tem_pedido === true && Number(aindaA.total_centavos) === 1500, JSON.stringify(aindaA));

  console.log('\n== 4. A lista de fontes sai do SERVIÇO, não da memória de quem escreveu ==\n');
  // Toda `fonte` que uma tool registra em mensagens_log escreve no MEIO do
  // turno e precisa estar na exclusão da 79.
  const dirTools = path.join(RAIZ, 'agente/src/tools');
  const fontesDeTool = new Set();
  for (const arq of fs.readdirSync(dirTools).filter((f) => f.endsWith('.ts'))) {
    const src = fs.readFileSync(path.join(dirTools, arq), 'utf8');
    if (!/api_n8n_registrar_mensagem/.test(src)) continue;
    for (const m of src.matchAll(/fonte:\s*'([a-z_]+)'/g)) fontesDeTool.add(m[1]);
  }
  chk('a varredura achou alguma fonte (lista vazia aprovaria qualquer migração)', fontesDeTool.size > 0, [...fontesDeTool].join(', '));
  const faltando = [...fontesDeTool].filter((f) => !M79.includes(`<> '${f}'`));
  chk('toda fonte escrita por tool está excluída da borda da janela na 79', faltando.length === 0, `faltando: ${faltando.join(', ')}`);

  console.log('\n== 5. Rollback ==\n');
  await c.query(semTx(R79));
  chk('o rollback devolve o comportamento antigo (o pedido some de novo)', (await estado(T.a, 391)).tem_pedido === false);
  await c.query(semTx(M79));
  chk('e reaplicar a 79 conserta de novo', (await estado(T.a, 391)).tem_pedido === true);
} finally {
  await c.query('rollback');
  await c.end();
}

console.log(`\n${ok} passaram, ${falhas.length} falharam\n`);
if (falhas.length) process.exit(1);
