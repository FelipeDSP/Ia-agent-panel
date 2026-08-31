#!/usr/bin/env node
/**
 * Toda `api_n8n_*` é executável pelo role com que o n8n conecta.
 *
 * POR QUE EXISTE. Em 17/08/2026 a migração 41 dropou e recriou
 * `api_n8n_buscar_produtos` e restaurou o grant só para `service_role`. O
 * catálogo morreu em produção com "permission denied for function". A mesma
 * migração 40, aplicada horas antes, tinha deixado `api_n8n_ver_pedido` no mesmo
 * estado — e ninguém tinha esbarrado ainda.
 *
 * `DROP FUNCTION` APAGA O ACL INTEIRO. Recriar restaura só o que o script
 * listar, e `service_role` é o role do PostgREST/supabase-js: o n8n não passa
 * por ali, ele conecta como `n8n_agent`. Verificar a função "por fora", com uma
 * conexão de superusuário, não vê nada disso — foi exatamente o erro da
 * verificação da 41, que conferiu os grants que ESPERAVA em vez dos que existiam.
 *
 * É a quinta armadilha de assinatura do repo (28, 32, 37, 40, 41) e a primeira
 * cujo modo de falha não é ambiguidade de aridade, e sim grant perdido. As
 * quatro primeiras quebravam a chamada; esta quebra a AUTORIZAÇÃO, e o sintoma
 * chega igual: a tool para no primeiro cliente.
 *
 * O teste é de PROPRIEDADE e não de lista: varre `api_n8n_*` no banco, então
 * função nova entra na vigilância sozinha. Uma lista fixa aqui envelheceria
 * calada — e guarda que envelhece calada é a classe de bug que ela deveria pegar.
 *
 * Uso: npm run teste:grants-n8n
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

/** O role com que o n8n conecta. Se mudar, muda aqui — e o teste diz por quê. */
const ROLE_N8N = 'n8n_agent';

let passou = 0;
const falhas = [];

function checar(nome, ok, detalhe = '') {
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

try {
  console.log('\n== Grants das funções api_n8n_* ==\n');

  const { rows: roles } = await c.query('select 1 from pg_roles where rolname = $1', [ROLE_N8N]);
  checar(
    `o role "${ROLE_N8N}" existe no banco`,
    roles.length === 1,
    'sem ele o teste inteiro seria vácuo — toda checagem abaixo passaria por ausência',
  );
  if (roles.length !== 1) throw new Error(`role ${ROLE_N8N} nao existe`);

  const { rows: fns } = await c.query(
    `select p.proname,
            pg_get_function_identity_arguments(p.oid) as args,
            coalesce(has_function_privilege($1, p.oid, 'execute'), false) as pode,
            coalesce(array_to_string(p.proacl, ' '), '(sem acl)') as acl
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname like 'api\\_n8n\\_%'
      order by p.proname`,
    [ROLE_N8N],
  );

  // Sem esta asserção, um erro no LIKE deixaria a varredura vazia e o teste
  // inteiro verde. É a mesma vacuidade que o repo varreu em 17/08.
  checar(
    `a varredura achou funções api_n8n_* (${fns.length})`,
    fns.length >= 10,
    `só ${fns.length} — o filtro deve estar errado`,
  );

  const semGrant = fns.filter((f) => !f.pode);
  checar(
    `todas as ${fns.length} api_n8n_* são executáveis por ${ROLE_N8N}`,
    semGrant.length === 0,
    semGrant.map((f) => `${f.proname} [acl: ${f.acl}]`).join(' | '),
  );

  // service_role tambem, porque o painel e a Edge Function passam por ele.
  const { rows: fnsSr } = await c.query(
    `select p.proname, coalesce(has_function_privilege('service_role', p.oid, 'execute'), false) as pode
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname like 'api\\_n8n\\_%'`,
  );
  const semSr = fnsSr.filter((f) => !f.pode).map((f) => f.proname);
  checar('todas continuam executáveis por service_role', semSr.length === 0, semSr.join(', '));

  // ---------------------------------------------------------------------------
  // PROPRIEDADE, E NAO LISTA: nenhuma SECURITY DEFINER ao alcance de `anon`
  // ---------------------------------------------------------------------------
  // O QUE ESTAVA AQUI ANTES, E POR QUE NAO PEGOU NADA. Havia uma varredura de
  // `api_n8n_*` com allowlist. Ela falhou duas vezes, de formas independentes:
  //
  //  1. ESCOPO. O filtro era `proname like 'api\_n8n\_%'`. Em 18/08 foram
  //     encontradas SETE funcoes SECURITY DEFINER abertas a `anon`, e QUATRO
  //     delas nao casam com o prefixo — `pedido_aberto_da_conversa`,
  //     `expirar_pedidos_vencidos`, `pedido_horas_para_expirar` e
  //     `tenants_versionar_prompt`. Eram invisiveis para o teste.
  //
  //  2. A ALLOWLIST, e esta e a pior. As outras tres (`enviar_foto`,
  //     `pode_transcrever`, `tem_pedido_pendente`) ESTAVAM na lista de
  //     esperadas, com a justificativa "sao chamadas pelo painel com JWT de
  //     tenant". A justificativa era FALSA: varredura em `src/` acha zero
  //     referencias as tres; quem chama sao workflows do n8n. Ou seja, a
  //     allowlist converteu um estado nao examinado em decisao documentada — que
  //     e exatamente como allowlist apodrece.
  //
  //     E o custo foi real: `api_n8n_pode_transcrever` devolve `chatwoot_token`.
  //     Em 18/08 o token do Emporio saiu por HTTPS, com a chave publicavel e sem
  //     sessao, so passando o `tenant_id`. A migracao 43 fechou.
  //
  // Por isso a assercao agora e sobre PROPRIEDADE e varre `public` inteiro:
  // funcao nova nasce coberta, com qualquer nome.
  {
    const { rows: expostas } = await c.query(
      `select p.proname, pg_get_function_identity_arguments(p.oid) args
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.prokind = 'f'
          and p.prosecdef
          and coalesce(has_function_privilege('anon', p.oid, 'execute'), false)
        order by p.proname`,
    );
    // SEM allowlist. `anon` e a chave que vai no bundle do navegador, e
    // SECURITY DEFINER ignora RLS: a combinacao nao tem caso legitimo neste
    // projeto. Se um dia tiver, o certo e discutir o caso, nao afrouxar a regra.
    // (`has_function_privilege` para `anon` ja cobre grant a PUBLIC, que e por
    // onde as sete estavam passando — nenhuma tinha `anon=` explicito sozinho.)
    checar(
      `nenhuma SECURITY DEFINER de public e executavel por anon (${expostas.length} encontradas)`,
      expostas.length === 0,
      expostas.map((f) => `${f.proname}(${f.args})`).join(' | '),
    );
  }

  // `authenticated` TEM caso legitimo: RPC que o painel chama com a sessao do
  // usuario. Aqui a lista e declarada e versionada — mas ela lista o que o
  // PAINEL usa, verificavel por grep em `src/`, e nao "o que por acaso esta
  // aberto". Uma quinta aparecer e falha.
  {
    const PAINEL = [
      'billing_consumo_mensal',   // /admin/consumo
      'billing_volume_mensal',    // /painel/relatorios (era /painel/consumo)
      'conversa_historico',       // /painel/conversas/[id]
      'agendar_podcast',          // formulario publico do site
    ];
    const { rows } = await c.query(
      `select p.proname
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.prokind = 'f' and p.prosecdef
          and coalesce(has_function_privilege('authenticated', p.oid, 'execute'), false)
        order by p.proname`,
    );
    const inesperadas = rows.map((r) => r.proname).filter((n) => !PAINEL.includes(n));
    checar(
      'nenhuma SECURITY DEFINER nova ficou aberta para authenticated',
      inesperadas.length === 0,
      inesperadas.join(', '),
    );
  }

  // ---------------------------------------------------------------------------
  // O FILTRO POR PREFIXO ESCONDE OS HELPERS — e ja escondeu duas vezes
  // ---------------------------------------------------------------------------
  // As asserções acima que falam de `n8n_agent` varrem `proname like
  // 'api\_n8n\_%'`. Isso e certo para a pergunta "o agente consegue chamar a
  // superficie dele?" e CEGO para tudo que a mesma migracao cria ao lado.
  //
  // Ja custou duas vezes, e a segunda esta no CLAUDE.md: a migracao 52 criou
  // `contato_exibivel`, o laco de conferencia percorria o prefixo, o helper nao
  // tem o prefixo, e ele saiu com `anon=X` — diferente da irma `texto_normalizado`,
  // de mesma natureza, criada na migracao seguinte. Nao era vazamento (funcao
  // pura), mas a conferencia nao tinha como saber disso: ela nao o viu.
  //
  // A licao registrada la e "confira o que a migracao CRIA, nao o que o nome dela
  // sugere". Os dois blocos abaixo sao isso, em forma de propriedade.
  //
  // POR QUE NAO DA PARA USAR `has_function_privilege` AQUI. Ele responde
  // "alcanca?", e alcance mistura grant explicito com heranca por PUBLIC. Medido
  // em 28/08: `n8n_agent` ALCANCA 14 funcoes fora do prefixo, e 12 delas so
  // porque as `ALTER DEFAULT PRIVILEGES` deste projeto dao EXECUTE a PUBLIC (a
  // mesma nota do CLAUDE.md sobre a migracao 54). Ou seja, a pergunta "o
  // n8n_agent alcanca?" responde SIM para quase tudo e nao distingue nada.
  // O que distingue e o aclitem `n8n_agent=` estar LA, escrito.
  {
    // Fora da superficie `api_n8n_*`, o agente so tem grant explicito nestas.
    // Lista declarada e versionada, com motivo — sao helpers de texto chamados
    // DENTRO das api_n8n_*, e receberam grant proprio nas migracoes 52 e 53.
    const HELPERS_COM_GRANT_AO_AGENTE = ['contato_exibivel', 'texto_normalizado'];

    const { rows } = await c.query(
      `select p.proname
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.prokind = 'f'
          and p.proname not like 'api\\_n8n\\_%'
          and exists (select 1 from unnest(coalesce(p.proacl, '{}'::aclitem[])) a
                       where a::text like 'n8n_agent=%')
        order by p.proname`,
    );
    const novas = rows.map((r) => r.proname).filter((n) => !HELPERS_COM_GRANT_AO_AGENTE.includes(n));
    checar(
      'nenhum grant explicito novo a n8n_agent fora do prefixo api_n8n_',
      novas.length === 0,
      `${novas.join(', ')} — se e proposital, declare em HELPERS_COM_GRANT_AO_AGENTE com o motivo`,
    );
  }

  // ---------------------------------------------------------------------------
  // A FORMA DO ACL, e nao a lista de nomes
  // ---------------------------------------------------------------------------
  // Toda SECURITY DEFINER de `public` cai em UMA de tres formas. Medido em
  // 28/08 e cobrindo as 34 que existem, com os grupos batendo exatamente:
  //
  //   n8n_agent+postgres+service_role  22  — a superficie api_n8n_*
  //   postgres+service_role             8  — helper interno; quem o chama e uma
  //                                          SECURITY DEFINER que roda como
  //                                          `postgres`, entao o agente NAO
  //                                          precisa de grant proprio
  //   authenticated+postgres+service_role 4 — RPC que o painel chama com a sessao
  //
  // Forma NOVA e falha, e e assim que esta asserção pega o caso que motivou o
  // bloco anterior: funcao criada sem `revoke` nasce com PUBLIC + `anon` +
  // `authenticated` (a nota do `arwdDxtm` no CLAUDE.md, versao para funcoes), o
  // que produz uma quarta forma na hora. Nao depende de alguem lembrar do nome
  // dela, nem de ela ter prefixo nenhum.
  {
    const PAINEL_AUTHENTICATED = [
      'agendar_podcast', 'billing_consumo_mensal', 'billing_volume_mensal', 'conversa_historico',
    ];
    const { rows } = await c.query(
      `select p.proname,
              (p.proname like 'api\\_n8n\\_%') as e_superficie,
              coalesce((select string_agg(split_part(a::text, '=', 1), '+'
                                          order by split_part(a::text, '=', 1))
                          from unnest(p.proacl) a), '(NULO)') as forma
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.prokind = 'f' and p.prosecdef
        order by p.proname`,
    );

    // Sem isto, um erro no filtro deixaria a varredura vazia e as tres
    // asserções abaixo passariam por vacuidade — a falha que o repo ja teve.
    checar(
      `a varredura de forma achou SECURITY DEFINER em public (${rows.length})`,
      rows.length >= 30,
      `so ${rows.length} — o filtro deve estar errado`,
    );

    const FORMA_SUPERFICIE = 'n8n_agent+postgres+service_role';
    const FORMA_HELPER = 'postgres+service_role';
    const FORMA_PAINEL = 'authenticated+postgres+service_role';
    const CONHECIDAS = [FORMA_SUPERFICIE, FORMA_HELPER, FORMA_PAINEL];

    const formaNova = rows.filter((r) => !CONHECIDAS.includes(r.forma));
    checar(
      'nenhuma SECURITY DEFINER tem forma de ACL fora das tres conhecidas',
      formaNova.length === 0,
      formaNova.map((r) => `${r.proname} [${r.forma}]`).join(' | '),
    );

    // A superficie tem de ter a forma da superficie...
    const superficieTorta = rows.filter((r) => r.e_superficie && r.forma !== FORMA_SUPERFICIE);
    checar(
      'toda api_n8n_* tem exatamente a forma da superficie',
      superficieTorta.length === 0,
      superficieTorta.map((r) => `${r.proname} [${r.forma}]`).join(' | '),
    );

    // ...e nada MAIS pode te-la. E o inverso do bloco anterior, pela forma:
    // helper novo que copie o bloco de grants da irma api_n8n_* cai aqui.
    const intrusa = rows.filter((r) => !r.e_superficie && r.forma === FORMA_SUPERFICIE);
    checar(
      'nenhum helper adotou a forma da superficie (grant a n8n_agent por copia)',
      intrusa.length === 0,
      intrusa.map((r) => r.proname).join(', '),
    );

    const painelTorto = rows.filter(
      (r) => r.forma === FORMA_PAINEL && !PAINEL_AUTHENTICATED.includes(r.proname),
    );
    checar(
      'nenhuma SECURITY DEFINER nova adotou a forma do painel (authenticated)',
      painelTorto.length === 0,
      painelTorto.map((r) => r.proname).join(', '),
    );
  }

  // PROVA FUNCIONAL, e nao so leitura de catalogo: `has_function_privilege` diz
  // o que o ACL contem, e chamar diz o que acontece. As duas divergem quando o
  // problema esta em outro lugar (search_path, owner, dependencia sem grant).
  console.log('\n  -- chamando de verdade, como o n8n chama --');
  const { rows: [tenant] } = await c.query('select id from public.tenants where deletado_em is null limit 1');
  const chamadas = [
    ['api_n8n_ver_pedido', 'select public.api_n8n_ver_pedido($1,$2)', [tenant.id, 990999]],
    ['api_n8n_buscar_produtos', 'select texto from public.api_n8n_buscar_produtos($1,$2)', [tenant.id, 'x']],
    ['api_n8n_tem_pedido_pendente', 'select public.api_n8n_tem_pedido_pendente($1,$2)', [tenant.id, 990999]],
    ['api_n8n_tools_ativas', 'select * from public.api_n8n_tools_ativas($1)', [tenant.id]],
  ];
  for (const [nome, sql, args] of chamadas) {
    await c.query('begin');
    let erro = null;
    try {
      await c.query(`set local role ${ROLE_N8N}`);
      await c.query(sql, args);
    } catch (e) {
      erro = e.message;
    }
    await c.query('rollback');
    checar(`${nome} responde como ${ROLE_N8N}`, erro === null, erro ?? '');
  }
} catch (e) {
  falhas.push(`ERRO INESPERADO: ${e.message}`);
  console.log(`  FALHA ERRO INESPERADO: ${e.message}`);
} finally {
  await c.end();
}

console.log(`\n${'-'.repeat(60)}`);
console.log(`  ${passou} passaram, ${falhas.length} falharam\n`);
if (falhas.length) {
  for (const f of falhas) console.log(`   - ${f}`);
  console.log('');
  process.exitCode = 1;
}
