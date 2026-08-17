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
  contarConteudo,
  criarTenantsEfemeros,
  removerTenantsEfemeros,
  semearConteudo,
} from './lib/tenants-efemeros.mjs';
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

/*
 * SEM SLUG DE SEED, e sem a Acqua.
 *
 * Este teste resolvia três tenants de seed por slug e usava a `acqua-lavanderia`
 * — cliente REAL em produção — como alvo do "não alcanço a base do outro". Duas
 * consequências, e as duas doeram:
 *
 * 1. Quando dois seeds foram soft-deletados em 13/08, o teste morreu na
 *    pré-condição e ficou quatro dias sem rodar.
 * 2. Mirar a Acqua tornava as asserções fortes POR ACIDENTE: elas só significam
 *    alguma coisa porque ela tem 12 documentos de verdade, e nada no teste
 *    conferia isso. No dia em que a base dela fosse limpa, "devolve 0 linhas"
 *    passaria a ser verdade por vacuidade, com a RLS ligada ou desligada.
 *
 * Agora são QUATRO tenants efêmeros: três participantes (um esconde todo bug de
 * isolamento, dois escondem vazamento unidirecional) e uma VÍTIMA, que faz o
 * papel do cliente real. Todos nascem com conteúdo, e o conteúdo é CONFERIDO —
 * é o que separa "a RLS barrou" de "não havia nada para ver".
 */
const MARCA_TENANT = 'fase2';

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

/**
 * Cria os quatro tenants e lhes dá conteúdo.
 *
 * A conferência no fim não é zelo: um `insert` que falhasse em silêncio deixaria
 * TODAS as asserções de isolamento verdes por vacuidade. É a diferença entre
 * "não vi nada porque a policy barrou" e "não vi nada porque não havia nada".
 */
async function prepararTenants() {
  const efemeros = await criarTenantsEfemeros(admin, { marca: MARCA_TENANT, quantidade: 4 });
  const participantes = efemeros.slice(0, 3);
  const vitima = efemeros[3];

  for (const t of participantes) {
    await semearConteudo(admin, t.id, { docs: 2, conversas: 1, tools: ['transferir_humano'] });
  }
  // A vítima faz o papel do cliente real: base maior e credencial de Chatwoot,
  // que é o segredo que nenhum tenant pode alcançar.
  await semearConteudo(admin, vitima.id, {
    docs: 3,
    conversas: 2,
    credencial: true,
    tools: ['transferir_humano', 'busca_conhecimento'],
  });

  for (const t of efemeros) {
    const c = await contarConteudo(admin, t.id);
    if (c.docs < 1 || c.conversas < 1 || c.tools < 1) {
      throw new Error(`tenant ${t.slug} ficou sem conteúdo (${JSON.stringify(c)}) — as asserções seriam vácuas`);
    }
  }
  const cv = await contarConteudo(admin, vitima.id);
  if (cv.credenciais !== 1) {
    throw new Error(`a vítima ficou sem credencial (${JSON.stringify(cv)}) — o teste do token não testaria nada`);
  }

  return { efemeros, participantes, vitima };
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

async function testarBanco(usuarios, vitima) {

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

    // O caso que mais importa: a vítima faz o papel do cliente real, e tem
    // conteúdo conferido em prepararTenants() — senão isto passaria vazio.
    const { data: docsAcqua } = await cliente
      .from('kb_documentos')
      .select('id')
      .eq('tenant_id', vitima.id);

    checar(
      `${usuario.slug}: não alcança a base da vítima (papel do cliente real)`,
      (docsAcqua ?? []).length === 0,
      `${(docsAcqua ?? []).length} linhas`,
    );

    /*
     * O TOKEN MORA EM `tenant_credenciais`, NÃO EM `tenants`.
     *
     * Esta asserção era `select('id, chatwoot_token').from('tenants')`, e a
     * coluna deixou de existir na migração 21 (11/08). O select passou a
     * ERRAR, `data` virou `null`, e `(null ?? []).length === 0` é `true` —
     * então a asserção de isolamento do segredo mais sensível do sistema estava
     * verde por não executar nada. Só apareceu ao trocar a Acqua por uma vítima
     * que o teste controla, porque aí foi preciso perguntar onde o token estava.
     */
    const credAlheia = await cliente
      .from('tenant_credenciais')
      .select('tenant_id, chatwoot_token')
      .eq('tenant_id', vitima.id);

    checar(
      `${usuario.slug}: não lê a credencial de Chatwoot do outro tenant`,
      !credAlheia.error && (credAlheia.data ?? []).length === 0,
      credAlheia.error ? `a query ERROU (${credAlheia.error.message})` : `${(credAlheia.data ?? []).length} linhas`,
    );

    // Contraprova: a linha EXISTE. Sem isto, "0 linhas" seria verdade mesmo com
    // a policy desligada — foi exatamente assim que a versão anterior passou.
    const { count: credDaVitima } = await admin
      .from('tenant_credenciais')
      .select('tenant_id', { count: 'exact', head: true })
      .eq('tenant_id', vitima.id);
    checar(
      `${usuario.slug}: (contraprova) a credencial da vítima existe de verdade`,
      credDaVitima === 1,
      `${credDaVitima} linhas no banco`,
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
      filter: { tenant_id: vitima.id },
    });

    checar(
      `${usuario.slug}: filtro de metadata com id da vítima devolve vazio`,
      (buscaForjada ?? []).length === 0,
      `${(buscaForjada ?? []).length} linhas`,
    );

    // -- API do n8n não é alcançável pelo painel ------------------------------

    const { error: erroN8n } = await cliente.rpc('api_n8n_buscar_kb', {
      p_tenant_id: vitima.id,
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

    // -- Config de tools (tenant_tools) de outro tenant ----------------------

    const { data: toolsVistas } = await cliente
      .from('tenant_tools')
      .select('id, tenant_id');

    const toolsAlheias = (toolsVistas ?? []).filter(
      (t) => t.tenant_id !== usuario.tenantId,
    );
    checar(
      `${usuario.slug}: não lista tenant_tools de outro tenant`,
      toolsAlheias.length === 0,
      `${toolsAlheias.length} alheias`,
    );

    const { data: toolsAcqua } = await cliente
      .from('tenant_tools')
      .select('id, config')
      .eq('tenant_id', vitima.id);
    checar(
      `${usuario.slug}: não lê a config de tools da vítima`,
      (toolsAcqua ?? []).length === 0,
      `${(toolsAcqua ?? []).length} linhas`,
    );

    const { data: toolUpdate } = await cliente
      .from('tenant_tools')
      .update({ ativo: false })
      .eq('tenant_id', outros[0].tenantId)
      .eq('tool_nome', 'transferir_humano')
      .select('id');
    checar(
      `${usuario.slug}: UPDATE em tenant_tools de ${outros[0].slug} não afeta linha`,
      (toolUpdate ?? []).length === 0,
      `${(toolUpdate ?? []).length} linhas alteradas`,
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

  const { efemeros, participantes, vitima } = await prepararTenants();
  console.log(`  tenants efêmeros: ${efemeros.map((t) => t.slug).join(', ')}`);
  console.log(`  vítima (papel do cliente real): ${vitima.slug}`);

  console.log('  Criando usuários de teste...');
  const usuarios = [];
  for (const t of participantes) {
    usuarios.push(await criarUsuarioTeste(t.slug, t.id));
  }
  console.log(`  ${usuarios.length} usuários criados.`);

  try {
    await testarBanco(usuarios, vitima);
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

    // Tenants por último: as 13 FKs são CASCADE, e apagá-los antes levaria junto
    // as linhas que a remoção de usuário ainda precisa encontrar.
    const sobraram = await removerTenantsEfemeros(admin, efemeros);
    if (sobraram.length) {
      falhas.push(`sobrou tenant efêmero: ${sobraram.join(', ')}`);
      console.log(`  ATENÇÃO: tenants efêmeros não removidos: ${sobraram.join(', ')}`);
    } else {
      console.log('  Tenants efêmeros removidos.');
    }
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
