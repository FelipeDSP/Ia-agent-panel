#!/usr/bin/env node
/**
 * Os deletes de limpeza da suíte respeitam a fronteira de tenant?
 *
 * POR QUE ISTO EXISTE. Quatro limpezas rodavam sem escopo de tenant, como
 * service_role (que ignora RLS): duas apagavam `produtos` por padrão de NOME na
 * tabela inteira, uma apagava `pedidos` por `conversation_id` — que não é único
 * entre tenants, e o próprio teste de pedidos existe para provar isso — e uma
 * apagava o histórico de prompt inteiro de um cliente. O que separava o catálogo
 * do Empório do catálogo do teste era o nome ser improvável.
 *
 * A GUARDA (`tests/lib/com-guarda.mjs`) DETECTA depois do fato. Este arquivo
 * PROVA o filtro antes: planta uma isca que casa exatamente com o critério da
 * limpeza, mas pertence a outro tenant, roda o teste de verdade e exige que a
 * isca sobreviva. Sem o `in('tenant_id', ...)`, cada caso aqui fica vermelho —
 * foi assim que cada um foi verificado.
 *
 * A isca de produto e de pedido mora num tenant EFÊMERO, criado e destruído
 * aqui. Nenhum cliente real entra na conta, nem por slug nem por id. A de
 * prompt_versoes precisa morar no próprio `clinica-teste`, porque o risco lá é
 * dentro do tenant — e ela é removida pelo id capturado.
 *
 * Uso: node tests/deletes-escopados.mjs
 */

import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';

import { createClient } from '@supabase/supabase-js';

import { carregarEnv } from '../scripts/lib/env.mjs';

carregarEnv();

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SECRETA = process.env.SUPABASE_SECRET_KEY;
if (!URL || !SECRETA) {
  console.error('\n  Faltam variáveis no .env.local.\n');
  process.exit(64);
}

const admin = createClient(URL, SECRETA, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// As MARCAS abaixo são cópias literais das que os testes usam para limpar. Se
// alguém mudar a marca lá e não aqui, a isca deixa de casar com o critério e
// este teste vira decoração — por isso a conferência de que a marca ainda
// aparece no arquivo, logo abaixo.
const MARCA_PRODUTOS = '__teste_iso_prod__';
const MARCA_FOTOS = '__teste_iso_foto__';
const CONV_A = 990001;

const SUFIXO = randomBytes(4).toString('hex');
const SLUG_ISCA = `zz-isca-deletes-${SUFIXO}`;

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

/** Roda um teste da suíte e devolve o código. Não propaga exceção. */
function rodar(arquivo) {
  try {
    execFileSync(process.execPath, [arquivo], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return 0;
  } catch (e) {
    if (e.status === undefined && e.stdout === undefined) {
      // Erro de spawn disfarçado de teste reprovado. Falha alto em vez de mentir.
      throw new Error(`não consegui rodar ${arquivo}: ${e.message}`);
    }
    return e.status ?? -1;
  }
}

let idIsca = null;
let idVersaoIsca = null;

try {
  console.log('\n== Limpeza da suíte respeita a fronteira de tenant? ==\n');

  // A marca ainda é a que o teste usa? Se mudou lá, a isca não casa e este
  // arquivo passaria verde sem exercitar nada.
  const fonteProdutos = execFileSync(process.execPath, ['-e',
    "process.stdout.write(require('fs').readFileSync('tests/isolamento-produtos.mjs','utf8'))"],
    { encoding: 'utf8' });
  checar(
    `a marca "${MARCA_PRODUTOS}" ainda é a usada por isolamento-produtos`,
    fonteProdutos.includes(`'${MARCA_PRODUTOS}'`),
    'a marca mudou lá e não aqui — a isca deixou de casar',
  );

  const { data: t, error: erroT } = await admin
    .from('tenants')
    .insert({ slug: SLUG_ISCA, nome: `isca de deletes ${SUFIXO}` })
    .select('id')
    .single();
  if (erroT) throw new Error(`criar tenant isca: ${erroT.message}`);
  idIsca = t.id;
  console.log(`  tenant isca: ${SLUG_ISCA}\n`);

  // --- produtos: as duas limpezas por nome ---
  const iscasProduto = [`${MARCA_PRODUTOS}isca`, `${MARCA_FOTOS}isca`];
  const { error: erroP } = await admin.from('produtos').insert(
    iscasProduto.map((nome) => ({ tenant_id: idIsca, nome, preco_centavos: 1234 })),
  );
  if (erroP) throw new Error(`criar produtos isca: ${erroP.message}`);

  // --- pedidos: mesma conversation_id que o teste apaga ---
  const { error: erroPed } = await admin
    .from('pedidos')
    .insert({ tenant_id: idIsca, conversation_id: CONV_A, status: 'rascunho' });
  if (erroPed) throw new Error(`criar pedido isca: ${erroPed.message}`);

  const sobrevivem = async () => {
    const { data: prods } = await admin
      .from('produtos').select('nome').eq('tenant_id', idIsca);
    const { data: peds } = await admin
      .from('pedidos').select('id').eq('tenant_id', idIsca).eq('conversation_id', CONV_A);
    return { produtos: (prods ?? []).length, pedidos: (peds ?? []).length };
  };

  const antes = await sobrevivem();
  checar('isca plantada: 2 produtos e 1 pedido', antes.produtos === 2 && antes.pedidos === 1,
    JSON.stringify(antes));

  console.log('\n  -- rodando os testes que limpam --');
  for (const arq of ['tests/isolamento-produtos.mjs', 'tests/isolamento-fotos.mjs', 'tests/isolamento-pedidos.mjs']) {
    const codigo = rodar(arq);
    checar(`${arq.replace('tests/', '')} passou`, codigo === 0, `saiu ${codigo}`);
  }

  const depois = await sobrevivem();
  checar(
    'os 2 produtos da isca SOBREVIVERAM à limpeza por nome',
    depois.produtos === 2,
    `sobraram ${depois.produtos} de 2`,
  );
  checar(
    'o pedido da isca SOBREVIVEU à limpeza por conversation_id',
    depois.pedidos === 1,
    `sobraram ${depois.pedidos} de 1`,
  );

  // --- prompt_versoes: o risco é DENTRO do tenant, não entre tenants ---
  console.log('\n  -- histórico de prompt do clinica-teste --');
  const { data: alvo } = await admin
    .from('tenants').select('id').eq('slug', 'clinica-teste').maybeSingle();
  if (!alvo) throw new Error('clinica-teste ausente — ver docs/PENDENCIA-SEED-DOS-TESTES.md');

  const { data: v, error: erroV } = await admin
    .from('prompt_versoes')
    .insert({ tenant_id: alvo.id, conteudo: `isca preexistente ${SUFIXO}` })
    .select('id')
    .single();
  if (erroV) throw new Error(`criar versão isca: ${erroV.message}`);
  idVersaoIsca = v.id;

  const codigoR = rodar('tests/restricao-coluna-fase3.mjs');
  checar('restricao-coluna-fase3 passou', codigoR === 0, `saiu ${codigoR}`);

  const { data: sobrou } = await admin
    .from('prompt_versoes').select('id').eq('id', idVersaoIsca).maybeSingle();
  checar(
    'a versão de prompt PREEXISTENTE sobreviveu à limpeza',
    Boolean(sobrou),
    'o histórico do cliente foi apagado junto com o do teste',
  );
} catch (e) {
  falhas.push(`ERRO INESPERADO: ${e.message}`);
  console.log(`  FALHA ERRO INESPERADO: ${e.message}`);
} finally {
  console.log('\n  Limpando...');
  if (idVersaoIsca) {
    await admin.from('prompt_versoes').delete().eq('id', idVersaoIsca);
  }
  if (idIsca) {
    // Duas condições: as 13 FKs para `tenants` são ON DELETE CASCADE, e um id
    // errado aqui apagaria catálogo e KB de um cliente sem soft delete.
    const { data, error } = await admin
      .from('tenants').delete().eq('id', idIsca).like('slug', 'zz-isca-deletes-%').select('id');
    if (error || (data ?? []).length !== 1) {
      console.log(`  ATENÇÃO: o tenant isca ${SLUG_ISCA} não foi removido — apague à mão.`);
    }
  }
  console.log('  Isca removida.');
}

console.log(`\n${'-'.repeat(60)}`);
console.log(`  ${passou} passaram, ${falhas.length} falharam\n`);
if (falhas.length) {
  for (const f of falhas) console.log(`   - ${f}`);
  console.log('');
  process.exitCode = 1;
}
