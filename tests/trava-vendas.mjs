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
// Um tenant pode ter contratado vendas, vendido de verdade e DEPOIS descontratado.
// Esses pedidos são legítimos e não podem reprovar o teste — mas afrouxar a regra
// para "ignore o histórico" cegaria o teste. O meio-termo é declarar o histórico
// aqui, explícito e versionado: qualquer pedido ALÉM destes é gravação nova para
// quem não contratou, que é exatamente o que este teste existe para impedir.
//
// Aumentar um número aqui é um ato deliberado e deve vir com justificativa no
// commit. Se você está prestes a aumentar para fazer o teste passar, pare: o
// teste provavelmente está certo.
const PEDIDOS_HISTORICOS = {
  // Venda real de 11/08/2026 (conv=1864, R$ 331,80), feita com vendas contratada.
  // A descontratação veio depois, em 12/08, ao testar o roteamento por perfil.
  'restaurante-teste': { pedidos: 1, itens: 2 },
};

console.log();
for (const t of semVendas) {
  const { count: nPedidos } = await admin
    .from('pedidos').select('id', { count: 'exact', head: true }).eq('tenant_id', t.id);
  const { count: nItens } = await admin
    .from('pedido_itens').select('id', { count: 'exact', head: true }).eq('tenant_id', t.id);
  const h = PEDIDOS_HISTORICOS[t.slug] ?? { pedidos: 0, itens: 0 };
  const rotulo = h.pedidos ? ` (histórico declarado: ${h.pedidos})` : '';
  checar(`${t.slug}: nenhum pedido novo${rotulo}`, (nPedidos ?? 0) <= h.pedidos,
    `${nPedidos} pedido(s), esperado no máximo ${h.pedidos}`);
  checar(`${t.slug}: nenhum item novo`, (nItens ?? 0) <= h.itens,
    `${nItens} item(ns), esperado no máximo ${h.itens}`);
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
  // A funcao devolve UMA linha sempre (migracao 41), com os totais dentro. Contar
  // linhas daria 1 mesmo para catalogo vazio -- que e exatamente o defeito que a
  // 41 existe para eliminar do lado do agente, e que aqui viraria falso negativo.
  const { data, error } = await admin.rpc('api_n8n_buscar_produtos', { p_tenant_id: t.id, p_termo: '' });
  if (error) throw new Error(`buscar_produtos(${t.slug}): ${error.message}`);
  const n = data?.[0]?.total_catalogo ?? 0;
  if (t.slug === 'acqua-lavanderia') {
    // Defesa em profundidade, não invariante do produto: a Acqua PODE cadastrar
    // catálogo um dia sem contratar vendas — a tela existe para todo tenant. Se
    // isso acontecer, isto vira informação, não falha, porque a barreira que
    // importa é a do sub-workflow e ela tem checagem própria acima.
    if (n === 0) {
      checar('acqua-lavanderia: catálogo vazio (2ª barreira)', true);
    } else {
      console.log(`  ----  acqua-lavanderia: ${n} produto(s) — a 2ª barreira deixou de valer, a 1ª segue`);
    }
  } else {
    console.log(`  ----  ${t.slug}: ${n} produto(s) no catálogo (esperado — a trava é do sub-workflow)`);
  }
}

// ---------------------------------------------------------------------------
// 5. As duas camadas têm que dizer a MESMA coisa
// ---------------------------------------------------------------------------
// POR QUE ESTE BLOCO EXISTE. Em 12/08/2026 o restaurante-teste estava com
// `contratado = false, ativo = true`, e as duas funções que respondem "esta tool
// vale para este tenant?" discordavam:
//
//   api_n8n_tools_ativas  -> false   (roteia o agente: 1ª camada)
//   api_n8n_config_tool   -> true    (trava do sub-workflow: 2ª camada)
//
// A defesa em duas camadas era uma camada com uma cópia decorativa, e estava
// assim desde a fatia 2.
//
// O resto deste teste NÃO pegou, e vale entender por quê: ele verifica ausência
// de pedido, e não havia pedido — o modelo, sem a tool anexada, INVENTOU a
// chamada em vez de fazê-la. Um teste de efeito colateral não vê um furo que
// ninguém explorou ainda. Este bloco compara as duas fontes diretamente, então
// pega a divergência mesmo sem ninguém exercitá-la.
console.log('\n  -- coerência entre as duas camadas --');
{
  const { data: tenantsVivos } = await admin
    .from('tenants').select('id, slug').eq('ativo', true).is('deletado_em', null);
  const { data: linhas } = await admin
    .from('tenant_tools').select('tenant_id, tool_nome, contratado, ativo');

  const porTenant = new Map((tenantsVivos ?? []).map((t) => [t.id, t.slug]));
  let pares = 0;
  const divergentes = [];

  for (const t of tenantsVivos ?? []) {
    const { data: ativas } = await admin.rpc('api_n8n_tools_ativas', { p_tenant_id: t.id });
    const ligadas = new Set((ativas ?? []).map((x) => x.tool_nome));

    for (const l of (linhas ?? []).filter((x) => x.tenant_id === t.id)) {
      const { data: cfg } = await admin.rpc('api_n8n_config_tool', {
        p_tenant_id: t.id, p_tool_nome: l.tool_nome,
      });
      const camada2 = (Array.isArray(cfg) ? cfg[0] : cfg)?.tool_ativa === true;
      const camada1 = ligadas.has(l.tool_nome);
      pares++;
      if (camada1 !== camada2) {
        divergentes.push(
          `${porTenant.get(t.id)}/${l.tool_nome}: tools_ativas=${camada1} config_tool=${camada2} ` +
          `(contratado=${l.contratado} ativo=${l.ativo})`
        );
      }
    }
  }

  /*
   * `pares > 0` e o que impede o verde mais bonito e mais vazio da suite.
   *
   * Se a query base de `tenant_tools` errar ou vier vazia, o laco nao roda,
   * `divergentes` fica vazio, e o teste ANUNCIA "as 2 camadas concordam em todos
   * os 0 pares" — e passa. O numero estava no rotulo desde sempre; ninguem le
   * rotulo de assercao verde.
   *
   * Verificado por sabotagem: filtrando a query base por um tool_nome
   * inexistente, a versao anterior imprimia OK com "0 pares".
   */
  checar(`as 2 camadas concordam em todos os ${pares} pares tenant×tool`,
    pares > 0 && divergentes.length === 0,
    pares === 0 ? 'ZERO pares comparados — a query base nao trouxe nada' : divergentes.join(' | '));

  // A regra por trás: uma tool só vale com contratado E ativo. Escrita
  // explicitamente para o teste falhar mesmo que AS DUAS funções errem juntas —
  // concordar não basta, elas têm que concordar no valor certo.
  const erradas = [];
  let conferidas = 0;
  for (const l of linhas ?? []) {
    if (!porTenant.has(l.tenant_id)) continue;
    const { data: cfg } = await admin.rpc('api_n8n_config_tool', {
      p_tenant_id: l.tenant_id, p_tool_nome: l.tool_nome,
    });
    const obtido = (Array.isArray(cfg) ? cfg[0] : cfg)?.tool_ativa === true;
    const esperado = l.contratado === true && l.ativo === true;
    conferidas++;
    if (obtido !== esperado) {
      erradas.push(`${porTenant.get(l.tenant_id)}/${l.tool_nome}: esperado ${esperado}, veio ${obtido}`);
    }
  }
  // Mesmo motivo do bloco acima: "nenhuma errada" entre zero linhas e vacuo.
  checar(`config_tool = (contratado AND ativo) nas ${conferidas} linhas`,
    conferidas > 0 && erradas.length === 0,
    conferidas === 0 ? 'ZERO linhas conferidas — a query base nao trouxe nada' : erradas.join(' | '));
}

// ---------------------------------------------------------------------------
// 6. Dados para a execução manual na UI do n8n
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
