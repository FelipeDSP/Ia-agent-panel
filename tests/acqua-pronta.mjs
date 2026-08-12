#!/usr/bin/env node
/**
 * Acqua pronta para voltar? — checagem pelo BANCO, antes de religar o bot.
 *
 * A Acqua está pausada por escolha do cliente enquanto otimizamos, sem tráfego
 * desde 24/07/2026. Quando ela voltar, o sistema estará bem diferente de julho:
 * o token do Chatwoot mudou de tabela (migração 21), o painel ganhou catálogo e
 * pedidos, o agente ganhou 4 tools de venda que ela NÃO contratou, e o rateio de
 * custo foi reescrito.
 *
 * Este teste responde uma pergunta só: **se ela mandar mensagem agora, funciona
 * como antes?** Ele não liga nada — só relata.
 *
 * O que ele NÃO cobre, e não tem como cobrir pelo banco:
 *   - se o webhook do Chatwoot dela ainda aponta para o n8n (é config no
 *     Chatwoot, não no nosso banco). O teste diz o que verificar lá;
 *   - se o número de WhatsApp dela segue conectado no inbox.
 * Esses dois só se confirmam mandando uma mensagem de verdade.
 *
 * Uso: node tests/acqua-pronta.mjs
 */

import { createClient } from '@supabase/supabase-js';

import { carregarEnv } from '../scripts/lib/env.mjs';

carregarEnv();

const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const SLUG = 'acqua-lavanderia';

let ok = 0;
const falhas = [];
const avisos = [];
function checar(nome, cond, detalhe = '') {
  if (cond) { ok++; console.log(`  OK     ${nome}`); }
  else { falhas.push(`${nome}${detalhe ? ` — ${detalhe}` : ''}`); console.log(`  FALHA  ${nome}${detalhe ? ` — ${detalhe}` : ''}`); }
}
function avisar(nome, detalhe) {
  avisos.push(`${nome} — ${detalhe}`);
  console.log(`  aviso  ${nome} — ${detalhe}`);
}

console.log('\n== Acqua pronta para voltar? ==\n');

// ---------------------------------------------------------------------------
// 1. O tenant existe, está vivo e o agente está ligado
// ---------------------------------------------------------------------------
const { data: t } = await admin
  .from('tenants')
  .select('id, nome, ativo, deletado_em, agente_ativo, chatwoot_account_id, chatwoot_url, modelo, debounce_segundos, system_prompt')
  .eq('slug', SLUG)
  .maybeSingle();

if (!t) {
  console.error(`\n  ERRO: tenant ${SLUG} não encontrado.\n`);
  process.exit(1);
}

console.log('  -- tenant --');
checar('tenant ativo', t.ativo === true);
checar('não está soft-deletado', t.deletado_em === null);
checar('agente_ativo ligado', t.agente_ativo === true,
  'com false o "Nao Pausado?" corta o fluxo e o agente não responde');
checar('system_prompt preenchido', Boolean((t.system_prompt ?? '').trim()),
  'sem ele o agente responde genérico');

// ---------------------------------------------------------------------------
// 2. Credencial do Chatwoot — mudou de lugar na migração 21
// ---------------------------------------------------------------------------
console.log('\n  -- credencial do Chatwoot (migração 21) --');
checar('chatwoot_account_id definido', Number.isInteger(t.chatwoot_account_id), String(t.chatwoot_account_id));
checar('chatwoot_url definido', Boolean(t.chatwoot_url));

// O caminho que o n8n usa de verdade. Testar a função e não a tabela: é ela que
// o workflow chama, e foi ela que a migração 21 reescreveu.
const { data: cred, error: erroCred } = await admin.rpc('api_n8n_credencial_chatwoot', { p_tenant_id: t.id });
const linhaCred = Array.isArray(cred) ? cred[0] : cred;
checar('api_n8n_credencial_chatwoot responde', !erroCred, erroCred?.message);
checar('devolve token não nulo', Boolean(linhaCred?.chatwoot_token),
  'o token vive em tenant_credenciais desde a migração 21');
checar('devolve url e account_id', Boolean(linhaCred?.chatwoot_url) && linhaCred?.chatwoot_account_id != null);

// O webhook entra por account_id, não por uuid: é o primeiro passo do fluxo.
const { data: porConta } = await admin.rpc('api_n8n_tenant_por_chatwoot', { p_account_id: t.chatwoot_account_id });
const linhaConta = Array.isArray(porConta) ? porConta[0] : porConta;
checar('api_n8n_tenant_por_chatwoot resolve a conta 56', linhaConta?.tenant_id === t.id,
  'sem isso o webhook chega e o fluxo para no "Tenant Valido?"');

// ---------------------------------------------------------------------------
// 3. Tools baseline ligadas, vendas NÃO contratada
// ---------------------------------------------------------------------------
console.log('\n  -- tools --');
const { data: tools } = await admin
  .from('tenant_tools')
  .select('tool_nome, contratado, ativo')
  .eq('tenant_id', t.id);

const BASELINE = ['busca_conhecimento', 'transferir_humano', 'resolver_conversa'];
for (const nome of BASELINE) {
  const linha = (tools ?? []).find((x) => x.tool_nome === nome);
  checar(`${nome}: contratada e ligada`, Boolean(linha?.contratado && linha?.ativo),
    linha ? `contratado=${linha.contratado} ativo=${linha.ativo}` : 'sem linha');
}

const vendas = (tools ?? []).find((x) => x.tool_nome === 'vendas');
checar('vendas NÃO contratada', !vendas?.contratado,
  'ela não comprou o módulo; contratar por engano faria o agente oferecer venda');

// A trava do lado do agente, pelo mesmo caminho que o sub-workflow usa.
const { data: cfg } = await admin.rpc('api_n8n_config_tool', { p_tenant_id: t.id, p_tool_nome: 'vendas' });
const linhaCfg = Array.isArray(cfg) ? cfg[0] : cfg;
checar('tool_ativa=false para vendas', linhaCfg?.tool_ativa === false, String(linhaCfg?.tool_ativa));

// ---------------------------------------------------------------------------
// 4. Nada de venda encostou nela
// ---------------------------------------------------------------------------
console.log('\n  -- isolamento de vendas --');
const { count: nProdutos } = await admin.from('produtos')
  .select('id', { count: 'exact', head: true }).eq('tenant_id', t.id);
const { count: nPedidos } = await admin.from('pedidos')
  .select('id', { count: 'exact', head: true }).eq('tenant_id', t.id);
// A propriedade é "quem não contratou não tem venda gravada", não "a Acqua tem
// zero produtos". Se ela contratar vendas um dia — evento comercial legítimo —,
// a segunda vira falsa e o teste ficaria vermelho por um acerto.
if (!vendas?.contratado) {
  checar('a trava funcionou: nenhum pedido para quem não contratou', (nPedidos ?? 0) === 0, `${nPedidos}`);
  checar('catálogo vazio (2ª barreira, defesa em profundidade)', (nProdutos ?? 0) === 0, `${nProdutos}`);
} else {
  avisar('vendas contratada para a Acqua',
    `${nProdutos} produto(s) e ${nPedidos} pedido(s) — a checagem de trava não se aplica mais`);
}

// ---------------------------------------------------------------------------
// 5. Base de conhecimento — é o que o agente dela usa
// ---------------------------------------------------------------------------
console.log('\n  -- base de conhecimento --');
const { data: chunks } = await admin.from('kb_documentos')
  .select('id, embedding, metadata, origem').eq('tenant_id', t.id).is('deletado_em', null);
const lista = chunks ?? [];
checar('chunks vetorizados presentes', lista.length > 0, `${lista.length} chunk(s)`);
checar('todos com embedding', lista.length > 0 && lista.every((c) => c.embedding != null),
  `${lista.filter((c) => c.embedding == null).length} sem embedding`);

// CLAUDE.md: o node PGVector do n8n filtra por METADATA, não pela coluna. Chunk
// sem tenant_id no metadata é invisível para o agente mesmo estando na tabela —
// e o sintoma seria "o agente esqueceu a base", não um erro.
const semTenantNoMeta = lista.filter((c) => (c.metadata ?? {}).tenant_id !== t.id);
checar('metadata de todo chunk carrega o tenant_id', semTenantNoMeta.length === 0,
  `${semTenantNoMeta.length} chunk(s) sem — o PGVector do n8n filtra por metadata`);

// A busca de verdade precisa de embedding (a função recebe vector, não texto),
// e não há chave da OpenAI no .env.local. O que dá para garantir daqui é que o
// caminho existe e está liberado para quem chama.
avisar('busca vetorial não testada aqui',
  'api_n8n_buscar_kb recebe embedding, não texto — só uma mensagem real exercita o caminho todo');

// ---------------------------------------------------------------------------
// 6. Conversas dela: nenhuma presa em pausa
// ---------------------------------------------------------------------------
console.log('\n  -- conversas --');
const { data: pausadas } = await admin.from('conversas')
  .select('conversation_id, status').eq('tenant_id', t.id).eq('status', 'pausado');
// AVISO, não falha. Pausar conversa é a feature funcionando: um humano assumiu.
// Como FALHA, este teste ficaria vermelho toda vez que alguém estivesse
// atendendo — vermelho por acerto, que é o jeito mais rápido de ensinar todo
// mundo a ignorar a suíte. O que importa saber antes de religar é o número, não
// um veredicto.
if ((pausadas ?? []).length > 0) {
  avisar('conversas pausadas',
    `${pausadas.length} — o agente não responde nelas até um humano despausar. Normal se há atendimento em curso`);
} else {
  ok++;
  console.log('  OK     nenhuma conversa pausada');
}

const { data: ultima } = await admin.from('conversas')
  .select('atualizado_em').eq('tenant_id', t.id)
  .order('atualizado_em', { ascending: false }).limit(1).maybeSingle();
if (ultima) {
  const dias = Math.floor((Date.now() - new Date(ultima.atualizado_em).getTime()) / 86400000);
  avisar('última atividade', `${dias} dias atrás — se ela voltar, a primeira mensagem confirma o webhook`);
}

// ---------------------------------------------------------------------------
// 7. O que só se confirma fora do banco
// ---------------------------------------------------------------------------
console.log('\n  ------------------------------------------------------------');
console.log('  NÃO dá para verificar daqui — confira antes de avisar o cliente:');
console.log('');
console.log('    1. No Chatwoot, conta 56: o webhook do Agent Bot ainda aponta');
console.log('       para o n8n? É config de lá, não do nosso banco.');
console.log('    2. O número de WhatsApp dela segue conectado no inbox?');
console.log('    3. O workflow "Agente Multi-Tenant (Supabase)" está Active?');
console.log('');
console.log('  Os três só se confirmam de verdade com uma mensagem real.');
console.log('  ------------------------------------------------------------');

console.log(`\n${'-'.repeat(60)}`);
console.log(`  ${ok} passaram, ${falhas.length} falharam, ${avisos.length} aviso(s)`);
if (falhas.length) {
  console.log('\n  FALHAS:');
  for (const f of falhas) console.log(`    - ${f}`);
  console.log('\n  NÃO religue antes de resolver.\n');
  process.exit(1);
}
console.log('\n  Do lado do banco, a Acqua está pronta para voltar.\n');
