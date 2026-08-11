#!/usr/bin/env node
/**
 * Isolamento do switch de "Meus módulos" (alternarModulo).
 *
 * O card passou a ter um switch por módulo, com Server Action que grava
 * `tenant_tools.ativo`. Este teste prova que a garantia de isolamento não
 * depende da UI: mesmo chamando o caminho de dados direto, com JWT real, o
 * cliente do tenant A não altera módulo do tenant B.
 *
 * A ação monta o filtro com o tenant_id do JWT (exigirTenantAdmin), nunca com
 * argumento do chamador, e a RLS de tenant_tools é a segunda camada. O que se
 * testa aqui é a segunda: com o JWT de A, um update mirando a linha de B tem que
 * atingir ZERO linhas — que é o que sobra se alguém um dia passar o tenant_id
 * por parâmetro e esquecer de sobrescrevê-lo.
 *
 * Também cobre o motivo de a ação tocar SÓ `ativo`: mandar `ativo` e
 * `contratado` no mesmo update faz o guard tenant_tools_guard_colunas reprovar o
 * update INTEIRO, inclusive a parte legítima.
 *
 * Usa três tenants (clinica-teste, restaurante-teste, sandbox-de-testes) — um só
 * esconderia todo bug de isolamento e dois esconderiam vazamento unidirecional.
 * Tudo é criado e removido pelo próprio teste.
 *
 * Uso: node tests/isolamento-modulos.mjs
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

const SENHA = 'IsolamentoModulos#2026';
const TOOL = '__teste_modulo_switch__';
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

async function ativoDe(tenantId) {
  const { data } = await admin.from('tenant_tools')
    .select('ativo').eq('tenant_id', tenantId).eq('tool_nome', TOOL).maybeSingle();
  return data?.ativo ?? null;
}

async function main() {
  console.log('\n== Isolamento do switch de Meus módulos ==\n');

  const { data: tenants, error: erroT } = await admin
    .from('tenants').select('id, slug, nome').in('slug', SLUGS);
  if (erroT) throw new Error(`carregar tenants: ${erroT.message}`);
  if ((tenants ?? []).length !== 3) {
    throw new Error(`esperava 3 tenants (${SLUGS.join(', ')}), achei ${tenants?.length ?? 0}`);
  }
  const porSlug = Object.fromEntries(tenants.map((t) => [t.slug, t]));
  const A = porSlug['clinica-teste'];
  const B = porSlug['restaurante-teste'];
  const C = porSlug['sandbox-de-testes'];

  const emails = {
    A: 'teste-modulos-a@exemplo.invalido',
    B: 'teste-modulos-b@exemplo.invalido',
  };
  const ids = { A: null, B: null };

  async function limparTudo() {
    await admin.from('tenant_tools').delete().in('tenant_id', [A.id, B.id, C.id]).eq('tool_nome', TOOL);
    await admin.from('catalogo_tools').delete().eq('tool_nome', TOOL);
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

    // Catálogo (FK da migração 20) + uma linha contratada e DESLIGADA em cada
    // tenant. Desligada de propósito: é o estado do bug — módulo contratado que
    // o cliente não conseguia ligar.
    {
      const { error } = await admin.from('catalogo_tools').upsert(
        [{ tool_nome: TOOL, nome_exibicao: 'Teste switch de módulo', schema_config: {} }],
        { onConflict: 'tool_nome' },
      );
      if (error) throw new Error(`semear catálogo: ${error.message}`);
    }
    {
      const { error } = await admin.from('tenant_tools').insert(
        [A, B, C].map((t) => ({
          tenant_id: t.id, tool_nome: TOOL, ativo: false, contratado: true,
          workflow_id: 'wf_teste', descricao: 'linha de teste', config: {},
        })),
      );
      if (error) throw new Error(`semear tenant_tools: ${error.message}`);
    }

    ids.A = await criar(emails.A, { papel: 'tenant_admin', tenant_id: A.id });
    ids.B = await criar(emails.B, { papel: 'tenant_admin', tenant_id: B.id });
    const cA = await autenticar(emails.A);
    const cB = await autenticar(emails.B);

    // 1. Caminho feliz: A liga o próprio módulo. É o bug que motivou a mudança —
    //    módulo sem config de cliente não tinha como ser ligado.
    {
      const { error } = await cA.from('tenant_tools')
        .update({ ativo: true }).eq('tenant_id', A.id).eq('tool_nome', TOOL);
      checar('A liga o próprio módulo', !error, error?.message);
      checar('ativo de A virou true', (await ativoDe(A.id)) === true, `ativo=${await ativoDe(A.id)}`);
    }

    // 2. E desliga de volta — o switch tem que funcionar nas duas direções.
    {
      const { error } = await cA.from('tenant_tools')
        .update({ ativo: false }).eq('tenant_id', A.id).eq('tool_nome', TOOL);
      checar('A desliga o próprio módulo', !error, error?.message);
      checar('ativo de A voltou para false', (await ativoDe(A.id)) === false);
      await cA.from('tenant_tools').update({ ativo: true }).eq('tenant_id', A.id).eq('tool_nome', TOOL);
    }

    // 3. ISOLAMENTO: A mira a linha de B explicitamente. Tem que atingir ZERO
    //    linhas — é o que sobra se o tenant_id um dia vier do chamador.
    {
      const { data, error } = await cA.from('tenant_tools')
        .update({ ativo: true }).eq('tenant_id', B.id).eq('tool_nome', TOOL).select('id');
      const barrado = Boolean(error) || (data ?? []).length === 0;
      checar('A NÃO altera módulo de B', barrado, error ? `código ${error.code}` : `${data?.length} linha(s)`);
      checar('módulo de B continua desligado', (await ativoDe(B.id)) === false, `ativo=${await ativoDe(B.id)}`);
    }

    // 4. Sem filtro nenhum: um update "global" só pode pegar a própria linha.
    //    Pega o caso de alguém remover o .eq('tenant_id', ...) da ação.
    {
      const { data } = await cA.from('tenant_tools')
        .update({ ativo: true }).eq('tool_nome', TOOL).select('tenant_id');
      const alcancadas = (data ?? []).map((r) => r.tenant_id);
      const soOProprio = alcancadas.length <= 1 && alcancadas.every((id) => id === A.id);
      checar('update sem filtro de tenant alcança só a própria linha', soOProprio,
        `alcançou ${alcancadas.length} linha(s)`);
      checar('C (terceiro tenant) continua desligado', (await ativoDe(C.id)) === false,
        `ativo=${await ativoDe(C.id)}`);
      checar('B continua desligado após update sem filtro', (await ativoDe(B.id)) === false);
    }

    // 5. Vazamento na outra direção: B também não alcança A. Dois tenants
    //    esconderiam vazamento unidirecional; por isso os dois sentidos.
    {
      const { data, error } = await cB.from('tenant_tools')
        .update({ ativo: false }).eq('tenant_id', A.id).eq('tool_nome', TOOL).select('id');
      const barrado = Boolean(error) || (data ?? []).length === 0;
      checar('B NÃO altera módulo de A', barrado, error ? `código ${error.code}` : `${data?.length} linha(s)`);
      checar('módulo de A segue ligado', (await ativoDe(A.id)) === true, `ativo=${await ativoDe(A.id)}`);
    }

    // 6. Leitura: A não enxerga a linha de B (o card não pode listar módulo alheio).
    {
      const { data } = await cA.from('tenant_tools').select('tenant_id').eq('tool_nome', TOOL);
      const alheias = (data ?? []).filter((r) => r.tenant_id !== A.id);
      checar('A não LÊ linha de outro tenant', alheias.length === 0, `viu ${alheias.length} alheia(s)`);
    }

    // 7. Guard: `contratado` é da agência. A ação toca só `ativo` exatamente por
    //    isto — mandar as duas juntas reprova o update INTEIRO.
    {
      const { data, error } = await cA.from('tenant_tools')
        .update({ ativo: false, contratado: false })
        .eq('tenant_id', A.id).eq('tool_nome', TOOL).select('id');
      const barrado = Boolean(error) || (data ?? []).length === 0;
      checar('A NÃO altera ativo+contratado juntos', barrado, error ? `código ${error.code}` : 'passou');
      checar('ativo de A não mudou junto (update foi atômico)', (await ativoDe(A.id)) === true,
        `ativo=${await ativoDe(A.id)}`);
      const { data: chk } = await admin.from('tenant_tools')
        .select('contratado').eq('tenant_id', A.id).eq('tool_nome', TOOL).single();
      checar('contratado de A permanece true', chk?.contratado === true, `agora=${chk?.contratado}`);
    }

  } finally {
    console.log('\n  Limpando...');
    await limparTudo();
    if (ids.A) await removerPorId(admin, ids.A);
    if (ids.B) await removerPorId(admin, ids.B);
    console.log('  Usuários e linhas de teste removidos.');
  }

  console.log(`\n${'-'.repeat(56)}`);
  console.log(`  ${passou} passaram, ${falhas.length} falharam`);
  if (falhas.length) {
    console.log('\n  FALHAS:');
    for (const f of falhas) console.log(`    - ${f}`);
    process.exit(1);
  }
  console.log('\n  Isolamento do switch de módulos confirmado.\n');
}

main().catch((e) => { console.error('\n  ERRO:', e.message, '\n'); process.exit(1); });
