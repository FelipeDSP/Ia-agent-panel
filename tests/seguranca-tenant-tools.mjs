#!/usr/bin/env node
/**
 * Segurança de tenant_tools — critério de conclusão da §4.1 do
 * ESPEC-CATALOGO-DE-TOOLS (migração 18).
 *
 * Prova, com usuários reais autenticando de verdade (JWT, não simulação), que
 * DEPOIS da migração 18:
 *   - super_admin INSERE uma linha (contrata um módulo) → permitido
 *   - tenant_admin tentando INSERIR uma linha nova → BLOQUEADO (policy)
 *   - tenant_admin edita ativo + config da própria linha → permitido (whitelist)
 *   - tenant_admin tentando trocar workflow_id/descricao/tool_nome → ERRO (guard 42501)
 *   - tenant_admin tentando DELETAR a linha → BLOQUEADO (policy)
 *   - super_admin edita workflow_id e DELETA → permitido
 *
 * O guard é um trigger BEFORE UPDATE + policies por comando: valem para este
 * caminho (PostgREST com JWT do usuário) exatamente como valeriam para uma
 * Server Action. Rodar como postgres passaria enganosamente (adendo §5), por
 * isso usuários reais.
 *
 * Usa um tool_nome de descarte (`__teste_seg_*`) e o tenant clinica-teste
 * (sem chatwoot_account_id — o n8n nem roteia para ele). Tudo é removido no fim.
 *
 * Uso: node tests/seguranca-tenant-tools.mjs
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

const SENHA = 'SegurancaTools#2026';
const TOOL = '__teste_seg_tool__';        // linha que o super cria e o tenant edita
const TOOL_INSERT = '__teste_seg_insert__'; // tool_nome que o tenant tenta inserir
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
  console.log('\n== Segurança de tenant_tools — §4.1 (migração 18) ==\n');

  const { data: tenant, error: erroTenant } = await admin
    .from('tenants')
    .select('id, slug')
    .eq('slug', 'clinica-teste')
    .single();
  if (erroTenant || !tenant) throw new Error(`tenant clinica-teste não encontrado: ${erroTenant?.message}`);

  const emailTenant = 'teste-segtools-tenant@exemplo.invalido';
  const emailSuper = 'teste-segtools-super@exemplo.invalido';
  let idTenant = null;
  let idSuper = null;

  // Ordem da FK (migração 20): apaga tenant_tools (filho) antes do catálogo (pai).
  async function limparTudo() {
    await admin.from('tenant_tools').delete().eq('tenant_id', tenant.id).in('tool_nome', [TOOL, TOOL_INSERT]);
    await admin.from('catalogo_tools').delete().in('tool_nome', [TOOL, TOOL_INSERT]);
  }

  // Semeia o catálogo para os tool_nome de descarte, para que o INSERT do tenant
  // seja barrado pela POLICY (o que testamos), não pela FK.
  async function semearCatalogo() {
    const { error } = await admin.from('catalogo_tools').upsert([
      { tool_nome: TOOL, nome_exibicao: 'Teste segurança', schema_config: {} },
      { tool_nome: TOOL_INSERT, nome_exibicao: 'Teste insert', schema_config: {} },
    ], { onConflict: 'tool_nome' });
    if (error) throw new Error(`semear catálogo: ${error.message}`);
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

    idTenant = await criar(emailTenant, { papel: 'tenant_admin', tenant_id: tenant.id });
    idSuper = await criar(emailSuper, { papel: 'super_admin' });

    const cTenant = await autenticar(emailTenant);
    const cSuper = await autenticar(emailSuper);

    // garante estado limpo antes de começar, e semeia o catálogo (FK)
    await limparTudo();
    await semearCatalogo();

    // 0. tenant_admin NÃO lê o catálogo global (não enumera módulos que não
    //    contratou) — coração da §4.3. RLS super-only → 0 linhas, sem erro.
    {
      const { data, error } = await cTenant.from('catalogo_tools').select('tool_nome');
      checar('tenant_admin NÃO enumera o catálogo', !error && (data ?? []).length === 0,
        error ? `erro ${error.code}` : `viu ${data?.length} linha(s)`);
      const { data: dataSuper } = await cSuper.from('catalogo_tools').select('tool_nome');
      checar('super_admin lê o catálogo', (dataSuper ?? []).length >= 3, `viu ${dataSuper?.length ?? 0} linha(s)`);
    }

    // 1. super_admin INSERE a linha (contrata o módulo) → permitido
    {
      const { error } = await cSuper.from('tenant_tools').insert({
        tenant_id: tenant.id, tool_nome: TOOL, ativo: false,
        workflow_id: 'wf_original', descricao: 'desc original', config: {},
      });
      checar('super_admin insere linha (contrata módulo)', !error, error?.message);
    }

    // 2. tenant_admin tenta INSERIR uma linha nova → BLOQUEADO (policy insert só super)
    {
      const { data, error } = await cTenant.from('tenant_tools').insert({
        tenant_id: tenant.id, tool_nome: TOOL_INSERT, ativo: true,
        workflow_id: 'wf_pirata', descricao: 'auto-contratada', config: {},
      }).select('id');
      const barrado = Boolean(error) || (data ?? []).length === 0;
      checar('tenant_admin NÃO insere linha nova', barrado, error ? `código ${error.code}` : 'insert passou');
      // confirma que nada foi gravado
      const { count } = await admin.from('tenant_tools')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenant.id).eq('tool_nome', TOOL_INSERT);
      checar('nenhuma linha auto-contratada no banco', (count ?? 0) === 0, `${count} linha(s)`);
    }

    // 3. tenant_admin edita ativo + config da própria linha → permitido (whitelist)
    {
      const { error } = await cTenant.from('tenant_tools')
        .update({ ativo: true, config: { horario: { timezone: 'America/Sao_Paulo' } } })
        .eq('tenant_id', tenant.id).eq('tool_nome', TOOL);
      checar('tenant_admin edita ativo + config', !error, error?.message);
      const { data: check } = await admin.from('tenant_tools')
        .select('ativo').eq('tenant_id', tenant.id).eq('tool_nome', TOOL).single();
      checar('ativo mudou de fato para true', check?.ativo === true, `ativo=${check?.ativo}`);
    }

    // 4. tenant_admin tenta trocar workflow_id → ERRO (guard 42501)
    {
      const { data, error } = await cTenant.from('tenant_tools')
        .update({ workflow_id: 'wf_pirata' })
        .eq('tenant_id', tenant.id).eq('tool_nome', TOOL).select('id');
      const barrado = Boolean(error) || (data ?? []).length === 0;
      checar('tenant_admin NÃO troca workflow_id', barrado, error ? `código ${error.code}` : 'update passou');
      const { data: check } = await admin.from('tenant_tools')
        .select('workflow_id').eq('tenant_id', tenant.id).eq('tool_nome', TOOL).single();
      checar('workflow_id permanece o original', check?.workflow_id === 'wf_original', `agora=${check?.workflow_id}`);
    }

    // 5. tenant_admin tenta trocar descricao → ERRO (guard)
    {
      const { data, error } = await cTenant.from('tenant_tools')
        .update({ descricao: 'reescrita pelo cliente' })
        .eq('tenant_id', tenant.id).eq('tool_nome', TOOL).select('id');
      const barrado = Boolean(error) || (data ?? []).length === 0;
      checar('tenant_admin NÃO troca descricao', barrado, error ? `código ${error.code}` : 'update passou');
    }

    // 5b. tenant_admin tenta mudar `contratado` → ERRO (guard; coluna da agência)
    {
      const { data, error } = await cTenant.from('tenant_tools')
        .update({ contratado: false })
        .eq('tenant_id', tenant.id).eq('tool_nome', TOOL).select('id');
      const barrado = Boolean(error) || (data ?? []).length === 0;
      checar('tenant_admin NÃO troca contratado', barrado, error ? `código ${error.code}` : 'update passou');
      const { data: check } = await admin.from('tenant_tools')
        .select('contratado').eq('tenant_id', tenant.id).eq('tool_nome', TOOL).single();
      checar('contratado permanece true', check?.contratado === true, `agora=${check?.contratado}`);
    }

    // 6. tenant_admin tenta DELETAR a linha → BLOQUEADO (policy delete só super)
    {
      const { data, error } = await cTenant.from('tenant_tools')
        .delete().eq('tenant_id', tenant.id).eq('tool_nome', TOOL).select('id');
      const barrado = Boolean(error) || (data ?? []).length === 0;
      checar('tenant_admin NÃO deleta linha', barrado, error ? `código ${error.code}` : 'delete passou');
      const { count } = await admin.from('tenant_tools')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenant.id).eq('tool_nome', TOOL);
      checar('linha continua no banco após tentativa de delete', (count ?? 0) === 1, `${count} linha(s)`);
    }

    // 7. super_admin edita workflow_id → permitido
    {
      const { error } = await cSuper.from('tenant_tools')
        .update({ workflow_id: 'wf_novo' })
        .eq('tenant_id', tenant.id).eq('tool_nome', TOOL);
      checar('super_admin edita workflow_id', !error, error?.message);
    }

    // 7b. super_admin edita `contratado` (descontratar/recontratar) → permitido
    {
      const { error } = await cSuper.from('tenant_tools')
        .update({ contratado: false })
        .eq('tenant_id', tenant.id).eq('tool_nome', TOOL);
      checar('super_admin edita contratado', !error, error?.message);
    }

    // 8. super_admin DELETA → permitido
    {
      const { data, error } = await cSuper.from('tenant_tools')
        .delete().eq('tenant_id', tenant.id).eq('tool_nome', TOOL).select('id');
      checar('super_admin deleta linha', !error && (data ?? []).length === 1, error?.message);
    }

  } finally {
    console.log('\n  Limpando...');
    await limparTudo();
    if (idTenant) await removerPorId(admin, idTenant);
    if (idSuper) await removerPorId(admin, idSuper);
    console.log('  Usuários e linhas de teste removidos.');
  }

  console.log(`\n${'-'.repeat(56)}`);
  console.log(`  ${passou} passaram, ${falhas.length} falharam`);
  if (falhas.length) {
    console.log('\n  FALHAS:');
    for (const f of falhas) console.log(`    - ${f}`);
    process.exit(1);
  }
  console.log('\n  Segurança de tenant_tools (§4.1) confirmada.\n');
}

main().catch((e) => { console.error('\n  ERRO:', e.message, '\n'); process.exit(1); });
