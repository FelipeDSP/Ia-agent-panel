#!/usr/bin/env node
/**
 * Isolamento do catálogo de produtos (fatia 1 de vendas).
 *
 * Prova, com usuários reais autenticando de verdade (JWT, não simulação), que o
 * cliente do tenant A não lê nem escreve produto do tenant B — inclusive
 * mirando o id alheio explicitamente, que é o que uma chamada direta da Server
 * Action ou uma URL de edição adulterada fariam.
 *
 * Por que no nível de dados e não chamando a action: `salvarProduto` monta o
 * filtro com o tenant_id do JWT (exigirTenantAdmin), então um id alheio já não
 * casa. O que este teste cobre é a SEGUNDA camada — a RLS —, que é o que sobra
 * se alguém um dia passar o tenant por parâmetro e esquecer de sobrescrevê-lo.
 * Rodar como postgres passaria enganosamente; por isso usuários reais.
 *
 * Três tenants, não dois: um esconde todo bug de isolamento e dois escondem
 * vazamento unidirecional.
 *
 * Uso: node tests/isolamento-produtos.mjs
 */

import { createClient } from '@supabase/supabase-js';

import { carregarEnv } from '../scripts/lib/env.mjs';
import { criarUsuario, ehEmailDuplicado, removerPorEmail, removerPorId } from '../scripts/lib/usuarios.mjs';

carregarEnv();

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const PUBLICA = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const SECRETA = process.env.SUPABASE_SECRET_KEY;

if (!URL || !PUBLICA || !SECRETA) {
  console.error('\n  Faltam variáveis no .env.local.\n');
  process.exit(1);
}

const SENHA = 'IsolamentoProdutos#2026';
const MARCA = '__teste_iso_prod__'; // prefixo do nome, para limpar tudo no fim
const SLUGS = ['clinica-teste', 'restaurante-teste', 'sandbox-de-testes'];

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
  console.log('\n== Isolamento do catálogo de produtos ==\n');

  const { data: tenants, error: erroT } = await admin
    .from('tenants').select('id, slug').in('slug', SLUGS);
  if (erroT) throw new Error(`carregar tenants: ${erroT.message}`);
  if ((tenants ?? []).length !== 3) {
    throw new Error(`esperava 3 tenants (${SLUGS.join(', ')}), achei ${tenants?.length ?? 0}`);
  }
  const porSlug = Object.fromEntries(tenants.map((t) => [t.slug, t]));
  const A = porSlug['clinica-teste'];
  const B = porSlug['restaurante-teste'];
  const C = porSlug['sandbox-de-testes'];

  const emails = {
    A: 'teste-produtos-a@exemplo.invalido',
    B: 'teste-produtos-b@exemplo.invalido',
  };
  const ids = { A: null, B: null };
  const prod = { A: null, B: null, C: null };

  async function limparTudo() {
    await admin.from('produtos').delete().like('nome', `${MARCA}%`);
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

    // Um produto por tenant, todos com o MESMO sku: o índice único é por
    // tenant, então isto tem que passar. Se falhar aqui, o unique está global.
    {
      const { data, error } = await admin.from('produtos').insert([
        { tenant_id: A.id, nome: `${MARCA} da clinica`, preco_centavos: 2490, sku: 'SKU-COMPARTILHADO' },
        { tenant_id: B.id, nome: `${MARCA} do restaurante`, preco_centavos: 3500, sku: 'SKU-COMPARTILHADO' },
        { tenant_id: C.id, nome: `${MARCA} do sandbox`, preco_centavos: 100, sku: 'SKU-COMPARTILHADO' },
      ]).select('id, tenant_id');
      checar('mesmo SKU em 3 tenants diferentes (unique é por tenant)', !error, error?.message);
      if (error) throw new Error('sem produtos semeados, o resto não faz sentido');
      for (const linha of data) {
        if (linha.tenant_id === A.id) prod.A = linha.id;
        if (linha.tenant_id === B.id) prod.B = linha.id;
        if (linha.tenant_id === C.id) prod.C = linha.id;
      }
    }

    ids.A = await criar(emails.A, { papel: 'tenant_admin', tenant_id: A.id });
    ids.B = await criar(emails.B, { papel: 'tenant_admin', tenant_id: B.id });
    const cA = await autenticar(emails.A);
    const cB = await autenticar(emails.B);

    // 1. LEITURA — A vê só o próprio, mesmo sem filtrar por tenant.
    {
      const { data } = await cA.from('produtos').select('id, tenant_id').like('nome', `${MARCA}%`);
      const alheios = (data ?? []).filter((r) => r.tenant_id !== A.id);
      checar('A lê o próprio produto', (data ?? []).length === 1, `viu ${data?.length ?? 0}`);
      checar('A NÃO lê produto de outro tenant', alheios.length === 0, `viu ${alheios.length} alheio(s)`);
    }

    // 2. LEITURA POR ID ALHEIO — o caso da URL de edição adulterada.
    {
      const { data } = await cA.from('produtos').select('id, nome').eq('id', prod.B).maybeSingle();
      checar('A NÃO lê produto de B por id direto', !data, data ? `leu "${data.nome}"` : '');
      const { data: dC } = await cA.from('produtos').select('id').eq('id', prod.C).maybeSingle();
      checar('A NÃO lê produto de C por id direto', !dC);
    }

    // 3. ESCRITA EM ID ALHEIO — o caso da action chamada direto.
    {
      const { data, error } = await cA.from('produtos')
        .update({ preco_centavos: 1 }).eq('id', prod.B).select('id');
      const barrado = Boolean(error) || (data ?? []).length === 0;
      checar('A NÃO altera produto de B', barrado, error ? `código ${error.code}` : `${data?.length} linha(s)`);
      const { data: chk } = await admin.from('produtos').select('preco_centavos').eq('id', prod.B).single();
      checar('preço de B intacto', chk?.preco_centavos === 3500, `agora=${chk?.preco_centavos}`);
    }

    // 4. UPDATE SEM FILTRO — pega quem remover o .eq('tenant_id') da action.
    {
      const { data } = await cA.from('produtos')
        .update({ preco_centavos: 999 }).like('nome', `${MARCA}%`).select('tenant_id');
      const alcancadas = (data ?? []).map((r) => r.tenant_id);
      const soOProprio = alcancadas.every((id) => id === A.id);
      checar('update sem filtro de tenant alcança só o próprio', soOProprio, `alcançou ${alcancadas.length}`);
      const { data: outros } = await admin.from('produtos')
        .select('preco_centavos').in('id', [prod.B, prod.C]);
      checar('B e C mantêm o preço original',
        (outros ?? []).every((r) => r.preco_centavos !== 999),
        (outros ?? []).map((r) => r.preco_centavos).join(','));
    }

    // 5. SOFT DELETE alheio.
    {
      const { data } = await cA.from('produtos')
        .update({ deletado_em: new Date().toISOString() }).eq('id', prod.B).select('id');
      checar('A NÃO remove produto de B', (data ?? []).length === 0, `${data?.length} linha(s)`);
      const { data: chk } = await admin.from('produtos').select('deletado_em').eq('id', prod.B).single();
      checar('produto de B segue vivo', chk?.deletado_em === null);
    }

    // 6. INSERT com tenant_id alheio — é o WITH CHECK da policy que barra.
    //    Sem ele, o USING filtraria a leitura e a escrita cruzada passaria.
    {
      const { data, error } = await cA.from('produtos')
        .insert({ tenant_id: B.id, nome: `${MARCA} plantado`, preco_centavos: 1 }).select('id');
      const barrado = Boolean(error) || (data ?? []).length === 0;
      checar('A NÃO insere produto no catálogo de B', barrado, error ? `código ${error.code}` : 'insert passou');
      const { count } = await admin.from('produtos')
        .select('id', { count: 'exact', head: true }).eq('tenant_id', B.id).like('nome', `${MARCA} plantado%`);
      checar('nada plantado no catálogo de B', (count ?? 0) === 0, `${count} linha(s)`);
    }

    // 7. DELETE FÍSICO alheio (a UI usa soft, mas a API expõe delete).
    {
      const { data } = await cA.from('produtos').delete().eq('id', prod.B).select('id');
      checar('A NÃO apaga fisicamente produto de B', (data ?? []).length === 0, `${data?.length} linha(s)`);
      const { count } = await admin.from('produtos')
        .select('id', { count: 'exact', head: true }).eq('id', prod.B);
      checar('produto de B continua na tabela', (count ?? 0) === 1);
    }

    // 8. CAMINHO FELIZ — o próprio catálogo funciona de ponta a ponta.
    {
      const { data, error } = await cA.from('produtos')
        .insert({ tenant_id: A.id, nome: `${MARCA} novo da clinica`, preco_centavos: 1590, unidade: 'un' })
        .select('id, preco_centavos');
      checar('A cria produto no próprio catálogo', !error && (data ?? []).length === 1, error?.message);
      checar('preço gravado em centavos', data?.[0]?.preco_centavos === 1590, `veio ${data?.[0]?.preco_centavos}`);
      if (data?.[0]) {
        const { error: erroUpd } = await cA.from('produtos')
          .update({ preco_centavos: 1690 }).eq('id', data[0].id);
        checar('A edita o próprio produto', !erroUpd, erroUpd?.message);
        const { data: del } = await cA.from('produtos')
          .update({ deletado_em: new Date().toISOString() }).eq('id', data[0].id).select('id');
        checar('A remove o próprio produto (soft)', (del ?? []).length === 1);
      }
    }

    // 9. VAZAMENTO NA OUTRA DIREÇÃO — B também não alcança A.
    {
      const { data: lidos } = await cB.from('produtos').select('tenant_id').like('nome', `${MARCA}%`);
      const alheios = (lidos ?? []).filter((r) => r.tenant_id !== B.id);
      checar('B NÃO lê produto de outro tenant', alheios.length === 0, `viu ${alheios.length}`);
      const { data } = await cB.from('produtos')
        .update({ preco_centavos: 7 }).eq('id', prod.A).select('id');
      checar('B NÃO altera produto de A', (data ?? []).length === 0, `${data?.length} linha(s)`);
    }

  } finally {
    console.log('\n  Limpando...');
    await limparTudo();
    if (ids.A) await removerPorId(admin, ids.A);
    if (ids.B) await removerPorId(admin, ids.B);
    console.log('  Usuários e produtos de teste removidos.');
  }

  console.log(`\n${'-'.repeat(56)}`);
  console.log(`  ${passou} passaram, ${falhas.length} falharam`);
  if (falhas.length) {
    console.log('\n  FALHAS:');
    for (const f of falhas) console.log(`    - ${f}`);
    process.exit(1);
  }
  console.log('\n  Isolamento do catálogo confirmado.\n');
}

main().catch((e) => { console.error('\n  ERRO:', e.message, '\n'); process.exit(1); });
