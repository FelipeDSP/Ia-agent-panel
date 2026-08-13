#!/usr/bin/env node
/**
 * Mostra, por tenant, o que o painel do CLIENTE renderiza e o que fica só no
 * admin — aplicando as mesmas funções puras que as duas telas usam.
 *
 * PARA QUE SERVE. O filtro de `contratado` existe no painel desde a §5.2 e nunca
 * escondeu nada: até 13/08/2026 as 15 linhas de `tenant_tools` estavam todas
 * contratadas e ligadas. Este script é como se exercita a regra sem precisar
 * abrir quatro navegadores — e, principalmente, como se confere ANTES e DEPOIS
 * de descontratar um módulo num tenant de teste.
 *
 * NÃO É TESTE e não afirma nada: imprime estado. O teste da regra é
 * `npm run teste:grupos`, que roda sobre propriedade e não sobre o banco.
 *
 * Uso: npm run modulos:visiveis
 */

import { Client } from 'pg';

import {
  clientePodeDesligar,
  clienteVeModulo,
  grupoTool,
  secaoPadraoTemAnomalia,
} from '../src/lib/tools/registro.ts';

const conexao = process.env.SUPABASE_DB_URL;
if (!conexao) {
  console.error('SUPABASE_DB_URL ausente. Rode com: node --env-file=.env.local ...');
  process.exitCode = 1;
} else {
  const c = new Client({ connectionString: conexao, ssl: { rejectUnauthorized: false } });
  await c.connect();

  const { rows } = await c.query(`
    select t.slug, tt.tool_nome, tt.contratado, tt.ativo
      from public.tenant_tools tt
      join public.tenants t on t.id = tt.tenant_id
     where t.deletado_em is null
     order by t.slug, tt.tool_nome
  `);
  await c.end();

  const porTenant = new Map();
  for (const r of rows) {
    if (!porTenant.has(r.slug)) porTenant.set(r.slug, []);
    porTenant.get(r.slug).push(r);
  }

  for (const [slug, linhas] of porTenant) {
    console.log(`\n${slug}`);

    const visiveis = linhas.filter((l) => clienteVeModulo(l.tool_nome, l.contratado));
    const ocultos = linhas.filter((l) => !clienteVeModulo(l.tool_nome, l.contratado));

    console.log('  painel do cliente:');
    if (visiveis.length === 0) {
      console.log('    (nada — o card "Meus módulos" não renderiza)');
    }
    for (const l of visiveis) {
      const grupo = grupoTool(l.tool_nome);
      const controle = clientePodeDesligar(l.tool_nome)
        ? `switch [${l.ativo ? 'ligado' : 'desligado'}]`
        : 'formulário, sem switch';
      console.log(`    ${l.tool_nome.padEnd(20)} ${grupo.padEnd(13)} ${controle}`);
    }

    console.log('  oculto do cliente:');
    for (const l of ocultos) {
      const grupo = grupoTool(l.tool_nome);
      const motivo = !l.contratado ? 'não contratado' : 'grupo padrão';
      console.log(
        `    ${l.tool_nome.padEnd(20)} ${grupo.padEnd(13)} ${motivo}` +
          (l.contratado && !l.ativo ? '  <-- DESLIGADO' : ''),
      );
    }

    // Espelha a regra de auto-expandir do admin sobre os mesmos dados.
    const padrao = linhas.filter((l) => grupoTool(l.tool_nome) !== 'contratavel');
    if (secaoPadraoTemAnomalia(padrao)) {
      console.log('  admin: seção "Padrão do produto" ABRE SOZINHA (há módulo desligado)');
    }
  }

  console.log('');
}
