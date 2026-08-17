#!/usr/bin/env node
/**
 * A guarda vale o que a sabotagem provar.
 *
 * Uma rede que nunca viu um erro passar por ela é decoração — e este projeto já
 * teve oito casos verdes pelo motivo errado, um deles introduzido pelo commit
 * que consertava essa exata classe. Então aqui a guarda é submetida a seis
 * cenários: três em que ela TEM que reprovar, três em que ela NÃO PODE reprovar.
 *
 * Falso negativo (deixa passar) é o defeito óbvio. Falso positivo é igualmente
 * fatal: uma guarda que reclama do tenant efêmero legítimo vira ruído, e ruído
 * é desligado na segunda semana.
 *
 * A vítima é um tenant criado e destruído por este teste. Nenhum tenant real
 * entra na conta — nem por slug, nem por id, nem por varredura.
 *
 * Uso: node --env-file=.env.local tests/guarda-sabotagem.mjs
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

import { Client } from 'pg';

import { carregarEnv } from '../scripts/lib/env.mjs';

carregarEnv();

const URL_BANCO = process.env.SUPABASE_DB_URL;
if (!URL_BANCO) {
  console.error('\n  SUPABASE_DB_URL ausente no .env.local\n');
  process.exit(64);
}

const SUFIXO = randomBytes(4).toString('hex');
const SLUG_VITIMA = `zz-guarda-vitima-${SUFIXO}`;

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

function rodarGuarda(modo, idVitima) {
  return new Promise((resolve) => {
    const p = spawn(
      process.execPath,
      ['tests/lib/com-guarda.mjs', process.execPath, 'tests/lib/sabotador.mjs'],
      {
        env: { ...process.env, SABOTAGEM_MODO: modo, SABOTAGEM_TENANT: idVitima },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let saida = '';
    p.stdout.on('data', (d) => (saida += d));
    p.stderr.on('data', (d) => (saida += d));
    p.on('close', (codigo) => resolve({ codigo, saida }));
  });
}

const c = new Client({ connectionString: URL_BANCO, ssl: { rejectUnauthorized: false } });
await c.connect();

let idVitima = null;

/** Repõe a vítima no estado inicial: um tenant, um produto de preço conhecido. */
async function reporVitima() {
  await c.query('delete from public.produtos where tenant_id = $1', [idVitima]);
  await c.query(
    'insert into public.produtos (tenant_id, nome, preco_centavos) values ($1, $2, $3)',
    [idVitima, 'produto da vítima', 4990],
  );
}

try {
  console.log('\n== A guarda pega sabotagem? ==\n');

  const { rows } = await c.query(
    'insert into public.tenants (slug, nome) values ($1, $2) returning id',
    [SLUG_VITIMA, `vítima da guarda ${SUFIXO}`],
  );
  idVitima = rows[0].id;
  await reporVitima();
  console.log(`  vítima criada: ${SLUG_VITIMA}\n`);

  // --- Tem que reprovar (exit 2) ---

  {
    const { codigo, saida } = await rodarGuarda('apaga', idVitima);
    checar('DELETE em tenant alheio reprova', codigo === 2, `saiu ${codigo}`);
    checar('o relatório nomeia o tenant e a tabela', saida.includes(SLUG_VITIMA) && saida.includes('produtos'));
    await reporVitima();
  }

  {
    const { codigo, saida } = await rodarGuarda('altera', idVitima);
    checar('UPDATE sem mudar contagem reprova', codigo === 2, `saiu ${codigo}`);
    checar('o relatório classifica como alteração, não sumiço', saida.includes('~1'));
    await reporVitima();
  }

  {
    // O motivo de a guarda ser wrapper: o teste morre antes de limpar.
    const { codigo } = await rodarGuarda('apaga-e-crasha', idVitima);
    checar('sujeira sobrevivente a crash reprova', codigo === 2, `saiu ${codigo}`);
    await reporVitima();
  }

  // --- Não pode reprovar ---

  {
    const { codigo } = await rodarGuarda('nada', idVitima);
    checar('comando limpo passa', codigo === 0, `saiu ${codigo}`);
  }

  {
    const { codigo, saida } = await rodarGuarda('efemero', idVitima);
    checar('tenant efêmero próprio não é falso positivo', codigo === 0, `saiu ${codigo}`);
    checar('e o relatório não acusa nada', saida.includes('nenhum tenant preexistente foi tocado'));
  }

  {
    // Guarda limpa: o código do comando tem que chegar intacto, senão a guarda
    // esconde a falha do teste que ela está vigiando.
    const { codigo } = await rodarGuarda('falha-limpa', idVitima);
    // 7 é um código que só o sabotador produz. Com 1 esta asserção passava
    // mesmo quando o wrapper quebrava e o comando nem rodava.
    checar('comando que falha sem sujar propaga o próprio código', codigo === 7, `saiu ${codigo}`);
  }
} finally {
  if (idVitima) {
    // Duas condições de propósito: as 13 FKs para `tenants` são ON DELETE
    // CASCADE, então um id errado aqui apaga catálogo e KB de um cliente sem
    // soft delete e sem volta.
    const r = await c.query(
      "delete from public.tenants where id = $1 and slug like 'zz-guarda-vitima-%'",
      [idVitima],
    );
    if (r.rowCount !== 1) {
      console.log(`\n  ATENÇÃO: a vítima ${SLUG_VITIMA} não foi removida — apague à mão.`);
    }
  }
  await c.end();
}

console.log(`\n  ${passou} passaram, ${falhas.length} falharam\n`);
if (falhas.length) {
  for (const f of falhas) console.log(`   - ${f}`);
  console.log('');
  process.exit(1);
}
