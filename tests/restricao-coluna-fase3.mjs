#!/usr/bin/env node
/**
 * Restrição de coluna por papel — critério de conclusão da Fase 3.
 *
 * Prova, com usuários reais autenticando de verdade (JWT, não simulação), que:
 *   - tenant_admin edita o próprio system_prompt, mensagens, debounce e
 *     agente_ativo → permitido, e o prompt é versionado
 *   - tenant_admin tentando alterar modelo / temperatura / token → ERRO no banco
 *   - super_admin altera modelo do mesmo tenant → permitido
 *   - o versionamento gravou o prompt anterior em prompt_versoes
 *
 * O guard é um trigger BEFORE UPDATE: vale para este caminho (PostgREST com JWT
 * do usuário) exatamente como valeria para uma Server Action. Rodar como
 * postgres passaria enganosamente (adendo §5), por isso usuários reais.
 *
 * Uso: node tests/restricao-coluna-fase3.mjs
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

const SENHA = 'RestricaoColuna#2026';
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
  console.log('\n== Restrição de coluna por papel — Fase 3 ==\n');

  // Tenant e super admin existentes.
  const { data: tenant } = await admin
    .from('tenants')
    .select('id, slug, modelo, temperatura, system_prompt')
    .eq('slug', 'clinica-teste')
    .single();

  if (!tenant) {
    throw new Error('tenant de seed "clinica-teste" ausente — ver docs/PENDENCIA-SEED-DOS-TESTES.md');
  }

  /*
   * Quais versões de prompt JÁ existiam.
   *
   * A limpeza no `finally` apagava `prompt_versoes` inteiro do clinica-teste —
   * escopado por tenant, sim, mas levando junto o histórico que o teste não
   * criou. Como as versões nascem por trigger, o teste não conhece os ids que
   * gerou; então a regra é a inversa: apaga tudo MENOS o que já estava lá.
   */
  const { data: versoesAntes } = await admin
    .from('prompt_versoes')
    .select('id')
    .eq('tenant_id', tenant.id);
  const idsPreexistentes = (versoesAntes ?? []).map((v) => v.id);

  const emailTenant = 'teste-coluna-tenant@exemplo.invalido';
  const emailSuper = 'teste-coluna-super@exemplo.invalido';
  let idTenant = null;
  let idSuper = null;

  try {
    // --- cria os dois usuários de teste ---
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

    const promptOriginal = tenant.system_prompt;

    // 1. tenant_admin edita o próprio prompt → permitido
    {
      const novo = `PROMPT EDITADO PELO TENANT ${Date.now() % 100000}`;
      const { error } = await cTenant.from('tenants').update({ system_prompt: novo }).eq('id', tenant.id);
      checar('tenant_admin edita o próprio system_prompt', !error, error?.message);
    }

    // 2. tenant_admin edita debounce + agente_ativo + mensagens → permitido
    {
      const { error } = await cTenant.from('tenants')
        .update({ debounce_segundos: 15, agente_ativo: true, msg_fora_escopo: 'Só ajudo com este atendimento.' })
        .eq('id', tenant.id);
      checar('tenant_admin edita debounce/agente/mensagens', !error, error?.message);
    }

    // 3. tenant_admin tenta mudar MODELO → erro (guard 42501)
    {
      const { data, error } = await cTenant.from('tenants').update({ modelo: 'gpt-5' }).eq('id', tenant.id).select('id');
      const barrado = Boolean(error) || (data ?? []).length === 0;
      checar('tenant_admin NÃO altera modelo', barrado, error ? `código ${error.code}` : 'update passou sem erro');
      // confirma que o valor não mudou de fato
      const { data: check } = await admin.from('tenants').select('modelo').eq('id', tenant.id).single();
      checar('modelo permanece o original no banco', check.modelo === tenant.modelo, `agora=${check.modelo}`);
    }

    // 4. tenant_admin tenta mudar TEMPERATURA → erro
    {
      const { data, error } = await cTenant.from('tenants').update({ temperatura: 1.9 }).eq('id', tenant.id).select('id');
      const barrado = Boolean(error) || (data ?? []).length === 0;
      checar('tenant_admin NÃO altera temperatura', barrado, error ? `código ${error.code}` : 'passou');
    }

    // 5. tenant_admin tenta mudar TOKEN do Chatwoot → erro
    {
      const { data, error } = await cTenant.from('tenants').update({ chatwoot_token: 'roubado' }).eq('id', tenant.id).select('id');
      const barrado = Boolean(error) || (data ?? []).length === 0;
      checar('tenant_admin NÃO altera chatwoot_token', barrado, error ? `código ${error.code}` : 'passou');
    }

    // 6. tenant_admin tenta suspender a si mesmo (ativo) → erro
    {
      const { data, error } = await cTenant.from('tenants').update({ ativo: false }).eq('id', tenant.id).select('id');
      const barrado = Boolean(error) || (data ?? []).length === 0;
      checar('tenant_admin NÃO altera ativo', barrado, error ? `código ${error.code}` : 'passou');
    }

    // 7. super_admin altera modelo do mesmo tenant → permitido
    {
      const { error } = await cSuper.from('tenants').update({ modelo: 'gpt-4.1' }).eq('id', tenant.id);
      checar('super_admin altera modelo', !error, error?.message);
      // restaura
      await admin.from('tenants').update({ modelo: tenant.modelo }).eq('id', tenant.id);
    }

    // 8. o versionamento gravou o prompt anterior
    {
      const { count } = await admin.from('prompt_versoes')
        .select('id', { count: 'exact', head: true }).eq('tenant_id', tenant.id);
      checar('prompt_versoes acumulou versão(ões)', (count ?? 0) >= 1, `${count} versões`);
      // o prompt original deve estar entre as versões guardadas
      const { data: versoes } = await admin.from('prompt_versoes')
        .select('conteudo').eq('tenant_id', tenant.id);
      const contem = (versoes ?? []).some((v) => v.conteudo === promptOriginal);
      checar('prompt anterior foi preservado no histórico', contem);
    }

    // restaura o prompt original e limpa as versões de teste
    await admin.from('tenants').update({ system_prompt: promptOriginal }).eq('id', tenant.id);

  } finally {
    console.log('\n  Limpando...');
    if (idTenant) await removerPorId(admin, idTenant);
    if (idSuper) await removerPorId(admin, idSuper);
    // Remove só as versões que o teste gerou. Sem o `not in`, isto apagava o
    // histórico de prompt inteiro do cliente — que é dado que ninguém devolve.
    let limpeza = admin.from('prompt_versoes').delete().eq('tenant_id', tenant.id);
    if (idsPreexistentes.length) {
      limpeza = limpeza.not('id', 'in', `(${idsPreexistentes.join(',')})`);
    }
    await limpeza;
    console.log('  Usuários e versões de teste removidos.');
  }

  console.log(`\n${'-'.repeat(56)}`);
  console.log(`  ${passou} passaram, ${falhas.length} falharam`);
  if (falhas.length) {
    console.log('\n  FALHAS:');
    for (const f of falhas) console.log(`    - ${f}`);
    process.exit(1);
  }
  console.log('\n  Restrição de coluna por papel confirmada.\n');
}

main().catch((e) => { console.error('\n  ERRO:', e.message, '\n'); process.exit(1); });
