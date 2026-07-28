#!/usr/bin/env node
/**
 * Teste de isolamento entre tenants — critério de conclusão da Fase 2.
 *
 * Prova que um tenant_admin logado não alcança dado de outro tenant por
 * nenhuma das três vias:
 *
 *   1. Chamada de API      — cliente Supabase autenticado, com JWT de verdade
 *   2. Parâmetro forjado   — passando o tenant_id alheio explicitamente
 *   3. URL direta          — HTTP contra o app, com cookie de sessão real
 *
 * Por que usuários reais e não simulação: o adendo §5 avisa que teste rodado
 * como `postgres` passa enganosamente, porque superusuário ignora RLS. Aqui
 * cada usuário autentica de fato e recebe o JWT que as policies leem.
 *
 * A camada 3 só roda se o servidor estiver de pé (npm run dev). Sem ele, o
 * teste avisa que pulou em vez de fingir que passou.
 *
 * Uso:
 *   npm run dev                    (noutra janela, para a camada 3)
 *   node tests/isolamento-fase2.mjs
 */

import { createClient } from '@supabase/supabase-js';

import { carregarEnv } from '../scripts/lib/env.mjs';
import {
  acharPorEmail,
  criarUsuario,
  ehEmailDuplicado,
  removerPorEmail,
  removerPorId,
} from '../scripts/lib/usuarios.mjs';

carregarEnv();

const URL_SUPABASE = process.env.NEXT_PUBLIC_SUPABASE_URL;
const CHAVE_PUBLICA = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const CHAVE_SECRETA = process.env.SUPABASE_SECRET_KEY;
const BASE_APP = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000';

if (!URL_SUPABASE || !CHAVE_PUBLICA || !CHAVE_SECRETA) {
  console.error(
    '\n  ERRO: faltam variaveis no .env.local ' +
      '(NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, SUPABASE_SECRET_KEY)\n',
  );
  process.exit(1);
}

const REF_PROJETO = new URL(URL_SUPABASE).hostname.split('.')[0];
const SENHA = 'TesteIsolamento#2026';

/** Os três tenants de teste. A Acqua fica de fora: é cliente real. */
const TENANTS_TESTE = ['sandbox', 'clinica-teste', 'restaurante-teste'];

const admin = createClient(URL_SUPABASE, CHAVE_SECRETA, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ---------------------------------------------------------------------------
// Placar
// ---------------------------------------------------------------------------

let passou = 0;
const falhas = [];
const pulados = [];

function checar(nome, condicao, detalhe = '') {
  if (condicao) {
    passou++;
    console.log(`  OK    ${nome}`);
  } else {
    falhas.push(`${nome}${detalhe ? ` — ${detalhe}` : ''}`);
    console.log(`  FALHA ${nome}${detalhe ? ` — ${detalhe}` : ''}`);
  }
}

function pular(nome, motivo) {
  pulados.push(`${nome} — ${motivo}`);
  console.log(`  PULOU ${nome} — ${motivo}`);
}

// ---------------------------------------------------------------------------
// Preparação
// ---------------------------------------------------------------------------

async function buscarTenants() {
  const { data, error } = await admin
    .from('tenants')
    .select('id, slug, nome')
    .is('deletado_em', null);

  if (error) throw new Error(`nao foi possivel ler tenants: ${error.message}`);

  const porSlug = new Map(data.map((t) => [t.slug, t]));

  for (const slug of TENANTS_TESTE) {
    if (!porSlug.has(slug)) {
      throw new Error(`tenant de teste ausente no banco: ${slug}`);
    }
  }
  if (!porSlug.has('acqua-lavanderia')) {
    throw new Error('tenant acqua-lavanderia ausente');
  }

  return porSlug;
}

/**
 * Cria o usuário de teste, tolerando sobra de execução anterior.
 *
 * Tenta criar direto em vez de consultar antes: `listUsers` é eventualmente
 * consistente neste GoTrue e pode não enxergar um usuário recém-criado — uma
 * limpeza baseada nela remove nada e não avisa. O conflito de email, ao
 * contrário, é imediato. Ver scripts/lib/usuarios.mjs.
 */
async function criarUsuarioTeste(slug, tenantId) {
  const email = `teste-isolamento-${slug}@exemplo.invalido`;

  const params = {
    email,
    password: SENHA,
    email_confirm: true,
    app_metadata: { papel: 'tenant_admin', tenant_id: tenantId },
    user_metadata: { nome: `Teste ${slug}` },
  };

  let { data, error } = await criarUsuario(admin, params);

  if (error && ehEmailDuplicado(error)) {
    // Sobra de uma execução anterior: remove e cria de novo, para garantir
    // senha e app_metadata conhecidos.
    await removerPorEmail(admin, email, { tentativas: 5 });
    ({ data, error } = await criarUsuario(admin, params));
  }

  if (error) throw new Error(`falha ao criar usuario de ${slug}: ${error.message}`);

  // O id vem daqui: remover por id no fim não depende da listagem.
  return { email, id: data.user.id, slug, tenantId };
}

/** Cliente autenticado de verdade, com o JWT que as policies vão ler. */
async function autenticar(email) {
  const cliente = createClient(URL_SUPABASE, CHAVE_PUBLICA, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data, error } = await cliente.auth.signInWithPassword({
    email,
    password: SENHA,
  });

  if (error) throw new Error(`login falhou para ${email}: ${error.message}`);

  return { cliente, sessao: data.session };
}

// ---------------------------------------------------------------------------
// Camadas 1 e 2 — API e parâmetro forjado
// ---------------------------------------------------------------------------

async function testarBanco(usuarios, tenants) {
  const acqua = tenants.get('acqua-lavanderia');

  for (const usuario of usuarios) {
    const { cliente } = await autenticar(usuario.email);
    const outros = usuarios.filter((u) => u.tenantId !== usuario.tenantId);

    console.log(`\n  -- ${usuario.slug} --`);

    // -- Camada 1: listagem sem filtro nenhum --------------------------------

    const { data: tenantsVistos } = await cliente.from('tenants').select('id, slug');
    checar(
      `${usuario.slug}: enxerga só o próprio tenant`,
      tenantsVistos?.length === 1 && tenantsVistos[0].id === usuario.tenantId,
      `viu ${tenantsVistos?.length ?? 0}: ${(tenantsVistos ?? []).map((t) => t.slug).join(', ')}`,
    );

    const { data: docs } = await cliente.from('kb_documentos').select('id, tenant_id');
    const docsAlheios = (docs ?? []).filter((d) => d.tenant_id !== usuario.tenantId);
    checar(
      `${usuario.slug}: nenhum documento de outro tenant na listagem`,
      docsAlheios.length === 0,
      `${docsAlheios.length} alheios`,
    );

    const { data: convs } = await cliente.from('conversas').select('id, tenant_id');
    const convsAlheias = (convs ?? []).filter((c) => c.tenant_id !== usuario.tenantId);
    checar(
      `${usuario.slug}: nenhuma conversa de outro tenant na listagem`,
      convsAlheias.length === 0,
      `${convsAlheias.length} alheias`,
    );

    // -- Camada 2: tenant_id alheio passado explicitamente --------------------

    for (const outro of outros) {
      const { data } = await cliente
        .from('kb_documentos')
        .select('id')
        .eq('tenant_id', outro.tenantId);

      checar(
        `${usuario.slug}: forjar tenant_id de ${outro.slug} não devolve documento`,
        (data ?? []).length === 0,
        `${(data ?? []).length} linhas`,
      );
    }

    // O caso que mais importa: o cliente real em produção.
    const { data: docsAcqua } = await cliente
      .from('kb_documentos')
      .select('id')
      .eq('tenant_id', acqua.id);

    checar(
      `${usuario.slug}: não alcança a base da Acqua (cliente real)`,
      (docsAcqua ?? []).length === 0,
      `${(docsAcqua ?? []).length} linhas`,
    );

    const { data: tenantAcqua } = await cliente
      .from('tenants')
      .select('id, chatwoot_token')
      .eq('id', acqua.id);

    checar(
      `${usuario.slug}: não lê o token do Chatwoot da Acqua`,
      (tenantAcqua ?? []).length === 0,
    );

    // -- Escrita cruzada ------------------------------------------------------

    const { error: erroInsert } = await cliente.from('kb_documentos').insert({
      tenant_id: outros[0].tenantId,
      text: 'invasao',
      embedding: `[${Array(1536).fill(0).join(',')}]`,
      metadata: {},
    });

    checar(
      `${usuario.slug}: INSERT no tenant de ${outros[0].slug} é rejeitado`,
      Boolean(erroInsert),
      erroInsert ? '' : 'insert passou',
    );

    const { data: updateAlheio } = await cliente
      .from('tenants')
      .update({ nome: 'sequestrado' })
      .eq('id', outros[0].tenantId)
      .select('id');

    checar(
      `${usuario.slug}: UPDATE no tenant de ${outros[0].slug} não afeta linha`,
      (updateAlheio ?? []).length === 0,
      `${(updateAlheio ?? []).length} linhas alteradas`,
    );

    // -- Busca vetorial -------------------------------------------------------

    const { data: busca, error: erroBusca } = await cliente.rpc('match_kb_documentos', {
      query_embedding: `[${Array(1536).fill(0.01).join(',')}]`,
      match_count: 50,
      filter: {},
    });

    if (erroBusca) {
      checar(`${usuario.slug}: match_kb_documentos não vaza`, false, erroBusca.message);
    } else {
      const vazou = (busca ?? []).filter(
        (r) => r.metadata?.tenant_id && r.metadata.tenant_id !== usuario.tenantId,
      );
      checar(
        `${usuario.slug}: match_kb_documentos devolve só o próprio tenant`,
        vazou.length === 0,
        `${vazou.length} alheios`,
      );
    }

    // Filtro de metadata apontando para outro tenant não amplia escopo.
    const { data: buscaForjada } = await cliente.rpc('match_kb_documentos', {
      query_embedding: `[${Array(1536).fill(0.01).join(',')}]`,
      match_count: 50,
      filter: { tenant_id: acqua.id },
    });

    checar(
      `${usuario.slug}: filtro de metadata com id da Acqua devolve vazio`,
      (buscaForjada ?? []).length === 0,
      `${(buscaForjada ?? []).length} linhas`,
    );

    // -- API do n8n não é alcançável pelo painel ------------------------------

    const { error: erroN8n } = await cliente.rpc('api_n8n_buscar_kb', {
      p_tenant_id: acqua.id,
      p_embedding: `[${Array(1536).fill(0.01).join(',')}]`,
      p_limite: 5,
    });

    /*
     * Qualquer erro faria o teste passar, inclusive um de tipo — o que seria
     * falso positivo. Exige-se o motivo certo: 42501 (permissão negada) ou
     * PGRST202 (função fora do schema cache, ou seja, não exposta). As funções
     * api_n8n_* são SECURITY DEFINER e ignoram RLS: se um usuário do painel
     * conseguisse chamá-las passando um tenant_id qualquer, a Opção C caía.
     */
    const motivoCerto =
      erroN8n && (erroN8n.code === '42501' || erroN8n.code === 'PGRST202');

    checar(
      `${usuario.slug}: api_n8n_buscar_kb negada a usuário autenticado`,
      motivoCerto,
      erroN8n ? `código ${erroN8n.code}: ${erroN8n.message}` : 'chamada passou',
    );

    // -- Usuários de outros tenants ------------------------------------------

    const { data: usuariosVistos } = await cliente
      .from('usuarios_painel')
      .select('id, tenant_id');

    const usuariosAlheios = (usuariosVistos ?? []).filter(
      (u) => u.tenant_id && u.tenant_id !== usuario.tenantId,
    );

    checar(
      `${usuario.slug}: não lista usuários de outro tenant`,
      usuariosAlheios.length === 0,
      `${usuariosAlheios.length} alheios`,
    );

    await cliente.auth.signOut();
  }
}

// ---------------------------------------------------------------------------
// Camada 3 — URL direta
// ---------------------------------------------------------------------------

/**
 * Monta o cookie de sessão no formato do @supabase/ssr: prefixo `base64-`
 * seguido do JSON da sessão, fatiado em pedaços quando passa do limite.
 */
function montarCookiesSessao(sessao) {
  const nome = `sb-${REF_PROJETO}-auth-token`;
  const valor = `base64-${Buffer.from(JSON.stringify(sessao), 'utf8').toString('base64')}`;
  const LIMITE = 3180;

  if (valor.length <= LIMITE) return [`${nome}=${valor}`];

  const partes = [];
  for (let i = 0; i < valor.length; i += LIMITE) {
    partes.push(`${nome}.${partes.length}=${valor.slice(i, i + LIMITE)}`);
  }
  return partes;
}

async function servidorNoAr() {
  try {
    const r = await fetch(`${BASE_APP}/login`, { redirect: 'manual' });
    return r.status < 500;
  } catch {
    return false;
  }
}

async function testarHttp(usuarios) {
  console.log('\n  -- URL direta (HTTP) --');

  if (!(await servidorNoAr())) {
    pular('camada 3 (URL direta)', `servidor não responde em ${BASE_APP}; rode "npm run dev"`);
    return;
  }

  // Sem sessão: rota protegida manda para o login.
  const semSessao = await fetch(`${BASE_APP}/painel`, { redirect: 'manual' });
  const destinoSemSessao = semSessao.headers.get('location') ?? '';
  checar(
    'sem sessão: /painel redireciona para /login',
    semSessao.status >= 300 && semSessao.status < 400 && destinoSemSessao.includes('/login'),
    `status ${semSessao.status}, location ${destinoSemSessao}`,
  );

  const semSessaoAdmin = await fetch(`${BASE_APP}/admin/tenants`, { redirect: 'manual' });
  checar(
    'sem sessão: /admin/tenants redireciona para /login',
    semSessaoAdmin.status >= 300 &&
      semSessaoAdmin.status < 400 &&
      (semSessaoAdmin.headers.get('location') ?? '').includes('/login'),
    `status ${semSessaoAdmin.status}`,
  );

  // Com sessão de tenant_admin.
  const usuario = usuarios[0];
  const { sessao } = await autenticar(usuario.email);
  const cookie = montarCookiesSessao(sessao).join('; ');

  /*
   * Controle indispensável: confirma que o cookie foi aceito.
   *
   * Sem esta verificação, um cookie mal formado faria o app tratar o usuário
   * como deslogado, /admin/tenants redirecionaria para /login e o teste
   * seguinte passaria — pelo motivo errado. Aqui exigimos 200 em /painel
   * antes de concluir qualquer coisa sobre /admin.
   */
  const comSessao = await fetch(`${BASE_APP}/painel`, {
    headers: { cookie },
    redirect: 'manual',
  });

  const sessaoAceita = comSessao.status === 200;
  checar(
    `${usuario.slug}: sessão reconhecida em /painel (controle)`,
    sessaoAceita,
    `status ${comSessao.status}`,
  );

  if (!sessaoAceita) {
    pular(
      'camada 3: /admin/tenants com sessão de tenant_admin',
      'o controle acima falhou; resultado seria falso positivo',
    );
    return;
  }

  const html = await comSessao.text();
  checar(
    `${usuario.slug}: /painel não vaza nome de outro tenant no HTML`,
    !html.includes('Acqua Lavanderia'),
  );

  // O caso central: URL de super admin com sessão de tenant_admin.
  const admin403 = await fetch(`${BASE_APP}/admin/tenants`, {
    headers: { cookie },
    redirect: 'manual',
  });

  const foiRedirecionado = admin403.status >= 300 && admin403.status < 400;
  checar(
    `${usuario.slug}: /admin/tenants por URL direta é bloqueado`,
    foiRedirecionado,
    `status ${admin403.status}`,
  );

  if (!foiRedirecionado && admin403.status === 200) {
    const corpo = await admin403.text();
    checar(
      `${usuario.slug}: /admin/tenants não renderiza a lista de clientes`,
      !corpo.includes('Acqua Lavanderia'),
      'a página de administração foi servida com dados',
    );
  }
}

// ---------------------------------------------------------------------------

async function main() {
  console.log('\n== Isolamento entre tenants — Fase 2 ==\n');

  const tenants = await buscarTenants();

  console.log('  Criando usuários de teste...');
  const usuarios = [];
  for (const slug of TENANTS_TESTE) {
    usuarios.push(await criarUsuarioTeste(slug, tenants.get(slug).id));
  }
  console.log(`  ${usuarios.length} usuários criados.`);

  try {
    await testarBanco(usuarios, tenants);
    await testarHttp(usuarios);
  } finally {
    /*
     * Remoção por id, não por email: não depende da listagem eventualmente
     * consistente. Deixar tenant_admin de teste para trás seria pior que
     * falhar o teste.
     */
    console.log('\n  Removendo usuários de teste...');
    for (const u of usuarios) await removerPorId(admin, u.id);

    const restou = [];
    for (const u of usuarios) {
      if (await acharPorEmail(admin, u.email)) restou.push(u.email);
    }
    console.log(
      restou.length
        ? `  AVISO: sobraram ${restou.join(', ')} — remova manualmente`
        : '  Nenhum usuário de teste restante.',
    );
  }

  console.log(`\n${'-'.repeat(60)}`);
  console.log(`  ${passou} passaram, ${falhas.length} falharam, ${pulados.length} pulados`);

  if (pulados.length) {
    console.log('\n  Pulados:');
    for (const p of pulados) console.log(`    - ${p}`);
  }

  if (falhas.length) {
    console.log('\n  FALHAS:');
    for (const f of falhas) console.log(`    - ${f}`);
    console.log('');
    process.exit(1);
  }

  console.log('\n  Isolamento confirmado.\n');
}

main().catch((e) => {
  console.error('\n  ERRO:', e.message, '\n');
  process.exit(1);
});
