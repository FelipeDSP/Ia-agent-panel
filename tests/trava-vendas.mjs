#!/usr/bin/env node
/**
 * Trava `tool_ativa` das tools de venda — verificação pelo BANCO.
 *
 * O que este teste prova, e que uma chamada HTTP não provaria: que a checagem
 * roda ANTES de qualquer efeito colateral. Se ela estivesse depois do
 * `adicionar_item`, a requisição ainda retornaria "indisponível" — e a linha em
 * `pedidos` já existiria. Vazaria dado, não só comportamento.
 *
 * Por isso o critério é o estado do banco, não a resposta do workflow.
 *
 * COMO USAR
 *
 *   1. `node tests/trava-vendas.mjs`  → mostra os dados para a execução manual
 *      e registra a linha de base.
 *   2. Na UI do n8n, execute CADA sub-workflow de venda com esses dados
 *      (Execute Workflow → preencher os inputs).
 *   3. `node tests/trava-vendas.mjs`  → confirma que nada foi gravado.
 *
 * O teste falha se QUALQUER tenant sem vendas contratada tiver pedido. Não é só
 * sobre a Acqua: a regra vale para todo cliente que não comprou o módulo, e
 * escrever assim faz o teste continuar valendo quando houver outros.
 */

import { createClient } from '@supabase/supabase-js';

import { carregarEnv } from '../scripts/lib/env.mjs';

carregarEnv();

const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

let passou = 0;
const falhas = [];
const checar = (nome, ok, det = '') => {
  if (ok) { passou++; console.log(`  OK    ${nome}`); }
  else { falhas.push(`${nome}${det ? ` — ${det}` : ''}`); console.log(`  FALHA ${nome}${det ? ` — ${det}` : ''}`); }
};

console.log('\n== Trava tool_ativa das tools de venda ==\n');

// ---------------------------------------------------------------------------
// 1. Quem NÃO contratou vendas
// ---------------------------------------------------------------------------
const { data: tenants } = await admin
  .from('tenants')
  .select('id, slug, nome, chatwoot_account_id, tenant_tools(tool_nome, contratado, ativo)')
  .is('deletado_em', null)
  .eq('ativo', true);

const semVendas = (tenants ?? []).filter(
  (t) => !(t.tenant_tools ?? []).some((tt) => tt.tool_nome === 'vendas' && tt.contratado),
);

console.log('  Tenants ativos SEM vendas contratada:');
for (const t of semVendas) {
  console.log(`    - ${t.slug} (${t.id}${t.chatwoot_account_id ? `, conta Chatwoot ${t.chatwoot_account_id}` : ''})`);
}
console.log();

// ---------------------------------------------------------------------------
// 2. Pré-condições: a trava tem que responder "desligada" com a linha existindo
// ---------------------------------------------------------------------------
const { data: catalogo } = await admin.from('catalogo_tools').select('tool_nome').eq('tool_nome', 'vendas');
checar('linha `vendas` existe no catálogo global', (catalogo ?? []).length === 1,
  'sem ela, tool_ativa seria false por AUSÊNCIA de dado e a trava passaria pelo motivo errado');

for (const t of semVendas) {
  const { data } = await admin.rpc('api_n8n_config_tool', { p_tenant_id: t.id, p_tool_nome: 'vendas' });
  const ativa = Array.isArray(data) ? data[0]?.tool_ativa : data?.tool_ativa;
  checar(`tool_ativa = false para ${t.slug}`, ativa === false, `veio ${JSON.stringify(ativa)}`);
}

// ---------------------------------------------------------------------------
// 3. A INVARIANTE: nenhum pedido para quem não contratou
// ---------------------------------------------------------------------------
// É isto que uma checagem posicionada DEPOIS de um efeito colateral quebraria.
console.log();
for (const t of semVendas) {
  const { count: nPedidos } = await admin
    .from('pedidos').select('id', { count: 'exact', head: true }).eq('tenant_id', t.id);
  const { count: nItens } = await admin
    .from('pedido_itens').select('id', { count: 'exact', head: true }).eq('tenant_id', t.id);
  checar(`${t.slug}: nenhum pedido gravado`, (nPedidos ?? 0) === 0, `${nPedidos} pedido(s)`);
  checar(`${t.slug}: nenhum item gravado`, (nItens ?? 0) === 0, `${nItens} item(ns)`);
}

// ---------------------------------------------------------------------------
// 4. Catálogo: contexto, não asserção
// ---------------------------------------------------------------------------
// `api_n8n_buscar_produtos` NÃO checa `tool_ativa`, e está certo assim: quem
// checa é o sub-workflow, antes de chamá-la. Um tenant pode perfeitamente ter
// catálogo cadastrado e não ter contratado vendas — é o caso dos tenants de
// teste, que ganharam catálogo na fatia 1.
//
// Por isso aqui só se registra o tamanho. A única asserção é sobre a Acqua, e
// não porque a função devesse filtrar: é defesa em profundidade. Se a trava do
// sub-workflow falhasse, o catálogo vazio dela seria a segunda barreira.
console.log();
for (const t of semVendas) {
  const { data } = await admin.rpc('api_n8n_buscar_produtos', { p_tenant_id: t.id, p_termo: '' });
  const n = (data ?? []).length;
  if (t.slug === 'acqua-lavanderia') {
    checar('acqua-lavanderia: catálogo vazio (2ª barreira)', n === 0, `${n} produto(s)`);
  } else {
    console.log(`  ----  ${t.slug}: ${n} produto(s) no catálogo (esperado — a trava é do sub-workflow)`);
  }
}

// ---------------------------------------------------------------------------
// 5. Dados para a execução manual na UI do n8n
// ---------------------------------------------------------------------------
const acqua = semVendas.find((t) => t.slug === 'acqua-lavanderia');
if (acqua) {
  const { data: conv } = await admin
    .from('conversas').select('conversation_id').eq('tenant_id', acqua.id)
    .order('atualizado_em', { ascending: false }).limit(1).maybeSingle();

  console.log('\n  ------------------------------------------------------------');
  console.log('  Para executar na UI do n8n (Execute Workflow), use:');
  console.log(`    tenant_id       ${acqua.id}`);
  console.log(`    conversation_id ${conv?.conversation_id ?? '<qualquer, ex: 1>'}`);
  console.log('    acao            adicionar');
  console.log('    produto_id      00000000-0000-0000-0000-000000000000');
  console.log('    quantidade      1');
  console.log('    termo           lavagem');
  console.log('    metadados       {}');
  console.log('  Esperado em TODOS: o ramo "Vendas Indisponivel".');
  console.log('  Depois de executar os quatro, rode este teste de novo.');
  console.log('  ------------------------------------------------------------');
}

console.log(`\n${'-'.repeat(56)}`);
console.log(`  ${passou} passaram, ${falhas.length} falharam`);
if (falhas.length) {
  console.log('\n  FALHAS:');
  for (const f of falhas) console.log(`    - ${f}`);
  process.exit(1);
}
console.log('\n  Trava confirmada: nenhum efeito colateral para quem não contratou.\n');
