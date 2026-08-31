#!/usr/bin/env node
/**
 * Isolamento de pedidos (fatia 2 de vendas).
 *
 * Prova, com usuários reais autenticando de verdade (JWT, não simulação), que o
 * cliente do tenant A não lê nem altera pedido do tenant B — inclusive mirando
 * o id alheio explicitamente, que é o que uma URL adulterada faria.
 *
 * Por que este teste existe SEPARADO de `migracao-vendas.mjs`: aquele roda com
 * a conexão direta, como `postgres`, que passa por cima da RLS — ele prova a
 * lógica das funções, não o isolamento. Rodar isolamento como superusuário
 * passaria enganosamente (adendo §5 da especificação).
 *
 * Cobre as duas superfícies, que falham por motivos diferentes:
 *  - PostgREST com JWT do tenant  -> a RLS é quem segura;
 *  - funções api_n8n_* com p_tenant_id -> o filtro dentro da função é quem segura.
 *
 * Três tenants: um esconde todo bug de isolamento, dois escondem vazamento
 * unidirecional. Tudo é criado e removido pelo próprio teste.
 *
 * Uso: node tests/isolamento-pedidos.mjs
 */

import { createClient } from '@supabase/supabase-js';

import { carregarEnv } from '../scripts/lib/env.mjs';
import { criarUsuario, ehEmailDuplicado, removerPorEmail, removerPorId } from '../scripts/lib/usuarios.mjs';
import { criarTenantsEfemeros, removerTenantsEfemeros } from './lib/tenants-efemeros.mjs';

carregarEnv();

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const PUBLICA = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const SECRETA = process.env.SUPABASE_SECRET_KEY;

if (!URL || !PUBLICA || !SECRETA) {
  console.error('\n  Faltam variáveis no .env.local.\n');
  process.exit(1);
}

const SENHA = 'IsolamentoPedidos#2026';
/*
 * SEM SLUG DE SEED. Os três tenants são criados por este teste e destruídos por
 * ele. Antes eram `clinica-teste`, `restaurante-teste` e `sandbox-de-testes`
 * resolvidos por slug — e quando dois deles foram soft-deletados pelo painel em
 * 13/08 a suíte de isolamento ficou quatro dias cega. O critério agora é o de
 * `docs/PENDENCIA-SEED-DOS-TESTES.md`: apagar seed nenhum consegue deixar este
 * teste verde, porque ele não olha para seed nenhum.
 *
 * Continuam TRÊS: um esconde todo bug de isolamento, dois escondem vazamento
 * unidirecional.
 */
const MARCA_TENANT = 'pedidos';
// Faixa de conversation_id reservada ao teste: não colide com conversa real.
const CONV_A = 990001;
const CONV_B = 990002;

const admin = createClient(URL, SECRETA, { auth: { autoRefreshToken: false, persistSession: false } });

let passou = 0;
const falhas = [];
function checar(nome, ok, detalhe = '') {
  if (ok) { passou++; console.log(`  OK    ${nome}`); }
  else { falhas.push(`${nome}${detalhe ? ` — ${detalhe}` : ''}`); console.log(`  FALHA ${nome}${detalhe ? ` — ${detalhe}` : ''}`); }
}

async function autenticar(email) {
  const c = createClient(URL, PUBLICA, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data, error } = await c.auth.signInWithPassword({ email, password: SENHA });
  if (error) throw new Error(`login falhou (${email}): ${error.message}`);
  return c;
}

async function main() {
  /** Preenchido logo abaixo; declarado aqui para o `finally` alcançar. */
  let efemeros = [];
  console.log('\n== Isolamento de pedidos — JWT real, 3 tenants ==\n');

  efemeros = await criarTenantsEfemeros(admin, { marca: MARCA_TENANT });
  const [A, B, C] = efemeros;   // A e B ganham catálogo abaixo; C fica sem pedido
  console.log(`  tenants efêmeros: ${efemeros.map((t) => t.slug).join(', ')}\n`);

  const emails = { A: 'teste-pedidos-a@exemplo.invalido', B: 'teste-pedidos-b@exemplo.invalido' };
  const ids = { A: null, B: null };
  let pedidoA = null;
  let pedidoB = null;

  /*
   * ESCOPADO POR TENANT. `conversation_id` NÃO é único entre tenants — é o id da
   * conversa no Chatwoot, e a própria seção 3 deste teste existe para provar que
   * dois tenants podem ter a MESMA conversation_id. Apagar por ela sem filtro de
   * tenant, como service_role, apagava o pedido de quem por acaso tivesse 990001.
   * A faixa 99xxxx ser improvável era a única proteção.
   */
  async function limparTudo() {
    await admin
      .from('pedidos')
      .delete()
      .in('tenant_id', [A.id, B.id, C.id])
      .in('conversation_id', [CONV_A, CONV_B]);
  }

  try {
    async function criar(email, appMeta) {
      let { data, error } = await criarUsuario(admin, {
        email, password: SENHA, email_confirm: true, app_metadata: appMeta, user_metadata: { nome: email },
      });
      if (error && ehEmailDuplicado(error)) {
        await removerPorEmail(admin, email, { tentativas: 5 });
        ({ data, error } = await criarUsuario(admin, {
          email, password: SENHA, email_confirm: true, app_metadata: appMeta, user_metadata: { nome: email },
        }));
      }
      if (error) throw new Error(`criar ${email}: ${error.message}`);
      return data.user.id;
    }

    await limparTudo();

    /*
     * O CATÁLOGO É DESTE TESTE.
     *
     * Antes ele procurava um produto que já existisse no tenant de seed e, se
     * não achasse, mandava "rode a fatia 1 antes" — dependência de ORDEM entre
     * testes, em cima de dado que ninguém garantia. Com tenant efêmero não há o
     * que procurar: o produto é criado aqui, com preço conhecido, o que também
     * torna a asserção de total exata em vez de relativa ao catálogo do dia.
     */
    const prod = {};
    for (const [rot, t, preco] of [['A', A, 1500], ['B', B, 2500]]) {
      const { data, error } = await admin.from('produtos')
        .insert({ tenant_id: t.id, nome: `produto de ${rot}`, preco_centavos: preco })
        .select('id, nome, preco_centavos')
        .single();
      if (error) throw new Error(`criar produto de ${t.slug}: ${error.message}`);
      prod[rot] = data;
    }

    // Confere que o produto entrou pelas mesmas regras que as funções aplicam —
    // se `disponivel` ou `deletado_em` mudarem de default, isto avisa aqui em vez
    // de a falha aparecer como "pedido não criado" três asserções adiante.
    for (const [rot, t] of [['A', A], ['B', B]]) {
      const { data } = await admin.from('produtos')
        .select('id').eq('tenant_id', t.id).is('deletado_em', null).eq('disponivel', true)
        .or('estoque.is.null,estoque.gt.0').limit(1);
      if (!data?.[0]) throw new Error(`produto de ${rot} não ficou visível para as funções de venda`);
    }

    // Pedidos criados pelas próprias funções: é o caminho real do agente.
    await admin.rpc('api_n8n_adicionar_item', {
      p_tenant_id: A.id, p_conversation_id: CONV_A, p_produto_id: prod.A.id, p_quantidade: 2,
    });
    await admin.rpc('api_n8n_adicionar_item', {
      p_tenant_id: B.id, p_conversation_id: CONV_B, p_produto_id: prod.B.id, p_quantidade: 1,
    });
    ({ data: pedidoA } = await admin.from('pedidos').select('id, total_centavos').eq('tenant_id', A.id).eq('conversation_id', CONV_A).single());
    ({ data: pedidoB } = await admin.from('pedidos').select('id, total_centavos').eq('tenant_id', B.id).eq('conversation_id', CONV_B).single());
    checar('pedido de A criado pela função', Boolean(pedidoA?.id));
    checar('pedido de B criado pela função', Boolean(pedidoB?.id));
    checar('total de A = preço do catálogo × 2',
      pedidoA.total_centavos === prod.A.preco_centavos * 2,
      `total=${pedidoA.total_centavos} esperado=${prod.A.preco_centavos * 2}`);

    ids.A = await criar(emails.A, { papel: 'tenant_admin', tenant_id: A.id });
    ids.B = await criar(emails.B, { papel: 'tenant_admin', tenant_id: B.id });
    const cA = await autenticar(emails.A);
    const cB = await autenticar(emails.B);

    // ---------------------------------------------------------------------
    // 1. PostgREST: leitura escopada
    // ---------------------------------------------------------------------
    {
      const { data } = await cA.from('pedidos').select('id, tenant_id');
      const alheios = (data ?? []).filter((r) => r.tenant_id !== A.id);
      checar('A lê o próprio pedido', (data ?? []).some((r) => r.id === pedidoA.id));
      /*
       * SEGURA DE GRAÇA, e por isso NÃO leva `!error`.
       *
       * A asserção positiva logo acima usa o MESMO `data` desta query. Se ela
       * errasse, `data` seria `null` e a positiva reprovaria primeiro — então o
       * erro engolido (o defeito do chatwoot_token) não tem por onde entrar.
       * Acrescentar a checagem seria ruído. O que sustenta é a positiva estar na
       * MESMA query: mover uma das duas quebra a proteção sem aviso.
       */
      checar('A NÃO lê pedido de outro tenant', alheios.length === 0, `viu ${alheios.length}`);
    }
    {
      const { data, error } = await cA.from('pedidos').select('id').eq('id', pedidoB.id).maybeSingle();
      checar('A NÃO lê pedido de B por id direto', !error && !data,
        error ? `a query ERROU (${error.code})` : data ? 'leu' : '');
    }
    {
      const { data, error } = await cA.from('pedido_itens').select('id, tenant_id');
      const alheios = (data ?? []).filter((r) => r.tenant_id !== A.id);
      checar('A NÃO lê item de pedido alheio', !error && alheios.length === 0,
        error ? `a query ERROU (${error.code})` : `viu ${alheios.length}`);
    }

    // ---------------------------------------------------------------------
    // 2. PostgREST: escrita bloqueada nos dois sentidos
    // ---------------------------------------------------------------------
    // A policy é `for select`: nem o próprio pedido o cliente edita por aqui.
    // Quem escreve é o n8n, pelas funções definer.
    {
      const { data, error } = await cA.from('pedidos')
        .update({ total_centavos: 1 }).eq('id', pedidoB.id).select('id');
      const barrado = Boolean(error) || (data ?? []).length === 0;
      checar('A NÃO altera pedido de B', barrado, error ? `código ${error.code}` : `${data?.length} linha(s)`);
      const { data: chk } = await admin.from('pedidos').select('total_centavos').eq('id', pedidoB.id).single();
      checar('total de B intacto', chk.total_centavos === pedidoB.total_centavos);
    }
    {
      const { data, error } = await cA.from('pedidos')
        .update({ status: 'pago' }).eq('id', pedidoA.id).select('id');
      const barrado = Boolean(error) || (data ?? []).length === 0;
      checar('A NÃO altera nem o PRÓPRIO pedido por PostgREST (policy é só select)',
        barrado, error ? `código ${error.code}` : 'update passou');
    }
    {
      const { data, error } = await cA.from('pedidos')
        .insert({ tenant_id: B.id, conversation_id: 999999, status: 'rascunho' }).select('id');
      const barrado = Boolean(error) || (data ?? []).length === 0;
      checar('A NÃO insere pedido para B', barrado, error ? `código ${error.code}` : 'insert passou');
    }
    {
      const { data, error } = await cA.from('pedidos').delete().eq('id', pedidoB.id).select('id');
      checar('A NÃO apaga pedido de B', !error && (data ?? []).length === 0,
        error ? `a query ERROU (${error.code})` : `${data?.length} linha(s)`);
    }

    // ---------------------------------------------------------------------
    // 3. Funções api_n8n_*: o filtro por p_tenant_id é quem segura
    // ---------------------------------------------------------------------
    // O tenant_admin não tem grant nessas funções — a chamada nem chega ao corpo.
    {
      const { error } = await cA.rpc('api_n8n_ver_pedido', { p_tenant_id: A.id, p_conversation_id: CONV_A });
      checar('tenant_admin NÃO executa api_n8n_* (sem grant)', Boolean(error), error ? `código ${error.code}` : 'executou');
    }
    // Já com privilégio (como o n8n teria), o filtro interno é o que isola.
    {
      // PROPRIEDADE, E NAO A FRASE. Isto casava a string 'Nao ha pedido aberto',
      // e a migracao 55 trocou o texto por 'Nao ha pedido nesta conversa' — o
      // isolamento seguiu perfeito e a assercao ficou vermelha. Casar mensagem e
      // medir redacao. O que isola e B nao enxergar NADA de A.
      //
      // E "nao ve" e afirmacao negativa: sem a contraprova ela passa igual se a
      // conversa estiver vazia por qualquer motivo.
      const proprio = String((await admin.rpc('api_n8n_ver_pedido',
        { p_tenant_id: A.id, p_conversation_id: CONV_A })).data);
      checar('CONTRAPROVA: A enxerga o proprio pedido nessa mesma conversa',
        proprio.includes(prod.A.nome), proprio.slice(0, 60));

      const { data } = await admin.rpc('api_n8n_ver_pedido', { p_tenant_id: B.id, p_conversation_id: CONV_A });
      const texto = String(data);
      checar('B com a MESMA conversation_id de A não vê o pedido de A',
        !texto.includes(prod.A.nome), texto.slice(0, 60));
    }
    {
      const { data } = await admin.rpc('api_n8n_adicionar_item', {
        p_tenant_id: B.id, p_conversation_id: CONV_B, p_produto_id: prod.A.id, p_quantidade: 1,
      });
      checar('adicionar_item recusa produto de outro tenant',
        String(data).includes('nao esta disponivel'), String(data).slice(0, 60));
      const { data: itens } = await admin.from('pedido_itens').select('produto_id').eq('pedido_id', pedidoB.id);
      checar('produto de A não entrou no pedido de B',
        !(itens ?? []).some((i) => i.produto_id === prod.A.id), `${itens?.length} item(ns)`);
    }
    {
      const { data } = await admin.rpc('api_n8n_cancelar_pedido', { p_tenant_id: B.id, p_conversation_id: CONV_A });
      // De novo: nao a frase, e sim "a resposta nao AFIRMA que cancelou". A
      // prova de verdade e a linha seguinte, que le o banco. A contraprova de
      // que cancelar funciona mesmo esta no fim deste arquivo.
      checar('B não cancela pedido de A', !/^Carrinho descartado/i.test(String(data).trim()),
        String(data).slice(0, 70));
      const { data: chk } = await admin.from('pedidos').select('status').eq('id', pedidoA.id).single();
      checar('pedido de A continua rascunho', chk.status === 'rascunho', `status=${chk.status}`);
    }

    // ---------------------------------------------------------------------
    // 4. Vazamento na outra direção, e o terceiro tenant
    // ---------------------------------------------------------------------
    {
      const { data, error } = await cB.from('pedidos').select('tenant_id');
      const alheios = (data ?? []).filter((r) => r.tenant_id !== B.id);
      checar('B NÃO lê pedido de outro tenant', !error && alheios.length === 0,
        error ? `a query ERROU (${error.code})` : `viu ${alheios.length}`);
      const { data: upd, error: erroUpd } = await cB.from('pedidos').update({ total_centavos: 7 }).eq('id', pedidoA.id).select('id');
      checar('B NÃO altera pedido de A', !erroUpd && (upd ?? []).length === 0,
        erroUpd ? `a query ERROU (${erroUpd.code})` : `${upd?.length} linha(s)`);
    }
    {
      const { count } = await admin.from('pedidos')
        .select('id', { count: 'exact', head: true }).eq('tenant_id', C.id);
      checar('terceiro tenant segue sem pedido nenhum', (count ?? 0) === 0, `${count} pedido(s)`);
    }
    {
      // CONTRAPROVA DO CANCELAMENTO, por ultimo porque muda estado: se cancelar
      // nao funcionasse para NINGUEM, o "B nao cancela pedido de A" la em cima
      // passaria por vacuidade. Aqui A cancela o proprio carrinho e o banco
      // confirma.
      const { data } = await admin.rpc('api_n8n_cancelar_pedido',
        { p_tenant_id: A.id, p_conversation_id: CONV_A });
      const { data: dep } = await admin.from('pedidos').select('status').eq('id', pedidoA.id).single();
      checar('CONTRAPROVA: A cancela o PROPRIO carrinho e o banco muda',
        dep?.status === 'cancelado', `resposta=${String(data).slice(0, 40)} status=${dep?.status}`);
    }
  } finally {
    console.log('\n  Limpando...');
    await limparTudo();
    if (ids.A) await removerPorId(admin, ids.A);
    if (ids.B) await removerPorId(admin, ids.B);
    console.log('  Usuários e pedidos de teste removidos.');
    // Os tenants saem por ULTIMO: as 13 FKs sao CASCADE, e apaga-los antes
    // levaria junto as linhas que as limpezas acima precisam encontrar para
    // provar que fizeram o proprio trabalho.
    const sobraram = await removerTenantsEfemeros(admin, efemeros);
    if (sobraram.length) {
      console.log(`  ATENCAO: tenants efemeros nao removidos: ${sobraram.join(', ')}`);
      falhas.push(`sobrou tenant efemero: ${sobraram.join(', ')}`);
    }
  }

  console.log(`\n${'-'.repeat(56)}`);
  console.log(`  ${passou} passaram, ${falhas.length} falharam`);
  if (falhas.length) {
    console.log('\n  FALHAS:');
    for (const f of falhas) console.log(`    - ${f}`);
    process.exit(1);
  }
  console.log('\n  Isolamento de pedidos confirmado.\n');
}

main().catch((e) => { console.error('\n  ERRO:', e.message, '\n'); process.exit(1); });
