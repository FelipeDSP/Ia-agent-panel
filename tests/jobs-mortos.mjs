#!/usr/bin/env node
/**
 * Job de ingestão preso: expira na leitura, e pode ser dispensado.
 *
 * SÃO DUAS COISAS, e o teste as separa porque elas têm de sobreviver uma sem a
 * outra:
 *
 *   1. `marcarJobsMortos` — job em andamento além do limite vira `erro`;
 *   2. `dispensarJob` — job travado pode ser removido pelo cliente.
 *
 * (2) é BUG PRÓPRIO, não consequência de (1): antes, um job em `processando`
 * não podia ser dispensado por ninguém — a tela mostrava "processando" para
 * sempre e o botão recusava. Se alguém remover (1) daqui a seis meses, (2) tem
 * de continuar de pé; por isso as seções são independentes e cada uma falha
 * sozinha.
 *
 * POR QUE NÃO É TRANSAÇÃO ABORTADA, ao contrário dos outros testes de migração.
 * O que pode dar errado aqui não é SQL: é a string de filtro do PostgREST
 * (`or` com `and(...)` aninhado e um timestamp ISO cheio de `:` e `.`). Escrita
 * errada, ela não dá erro de compilação nem de sintaxe — devolve zero linhas, e
 * o botão "dispensar" simplesmente não funcionaria. Testar isso exige passar
 * pelo PostgREST de verdade, e o PostgREST não enxerga transação aberta de
 * outra conexão.
 *
 * Então planta linhas de verdade, mede, e APAGA no `finally` por id explícito.
 * Sempre no tenant de teste, nunca na Acqua. `jobs_ingestao` é metadado de
 * processamento efêmero — não é conteúdo de cliente.
 *
 * O NÚMERO VEM DA FONTE (`src/lib/jobs-mortos.ts`), não é copiado: teste que
 * repete a constante concorda consigo mesmo para sempre.
 *
 * Uso: npm run teste:jobs-mortos
 */

import { createClient } from '@supabase/supabase-js';

import {
  MINUTOS_JOB_MORTO,
  STATUS_EM_ANDAMENTO,
  filtroJobDispensavel,
  limiteJobMorto,
} from '../src/lib/jobs-mortos.ts';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const CHAVE = process.env.SUPABASE_SECRET_KEY;
if (!URL || !CHAVE) {
  console.error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SECRET_KEY ausentes. Rode com --env-file=.env.local');
  process.exit(1);
}

const sb = createClient(URL, CHAVE, { auth: { persistSession: false } });

let ok = 0;
const falhas = [];
const chk = (nome, cond, det = '') => {
  if (cond) { ok++; console.log(`  OK    ${nome}`); }
  else { falhas.push(`${nome}${det ? ' — ' + det : ''}`); console.log(`  FALHA ${nome}${det ? ' — ' + det : ''}`); }
};

const plantados = [];

async function plantar(tenantId, status, minutosAtras, nome) {
  const criado = new Date(Date.now() - minutosAtras * 60_000).toISOString();
  const { data, error } = await sb
    .from('jobs_ingestao')
    .insert({
      tenant_id: tenantId,
      arquivo_nome: nome,
      arquivo_path: null,
      tipo: 'texto',
      status,
      criado_em: criado,
    })
    .select('id')
    .single();
  if (error) throw new Error(`plantar(${nome}): ${error.message}`);
  plantados.push(data.id);
  return data.id;
}

const statusDe = async (id) =>
  (await sb.from('jobs_ingestao').select('status, erro_msg').eq('id', id).maybeSingle()).data;

const existe = async (id) =>
  Boolean((await sb.from('jobs_ingestao').select('id').eq('id', id).maybeSingle()).data);

try {
  console.log('\n== Job de ingestão preso ==\n');

  const { data: tenant } = await sb
    .from('tenants').select('id').eq('slug', 'sandbox-de-testes').maybeSingle();
  if (!tenant) throw new Error('tenant sandbox-de-testes nao encontrado');

  // ---------------------------------------------------------------------------
  console.log('\n-- 1. O limite erra para o lado longo --\n');

  // PROPRIEDADE, não o número. Fixar `=== 15` obrigaria a editar o teste toda
  // vez que o limite fosse ajustado — e o que importa não é o valor, é que ele
  // esteja com folga acima do pior caso legítimo medido (70 chunks em ~8 s;
  // ~600 chunks com retries, alguns minutos).
  chk(
    `limite (${MINUTOS_JOB_MORTO} min) tem folga sobre o pior caso legítimo`,
    MINUTOS_JOB_MORTO >= 5,
    `${MINUTOS_JOB_MORTO} min`,
  );
  const delta = Date.now() - new Date(limiteJobMorto()).getTime();
  chk(
    'limiteJobMorto fica no passado, na distância certa',
    Math.abs(delta - MINUTOS_JOB_MORTO * 60_000) < 2_000,
    `${Math.round(delta / 1000)}s`,
  );

  // ---------------------------------------------------------------------------
  console.log('\n-- 2. Expirar na leitura: só o que passou do limite --\n');

  const velho = await plantar(tenant.id, 'processando', MINUTOS_JOB_MORTO + 5, 'teste-preso-velho');
  const novo = await plantar(tenant.id, 'processando', MINUTOS_JOB_MORTO - 5, 'teste-preso-novo');
  const pronto = await plantar(tenant.id, 'concluido', MINUTOS_JOB_MORTO + 60, 'teste-concluido-velho');

  // A MESMA escrita que `marcarJobsMortos` faz.
  const { error: errUpd } = await sb
    .from('jobs_ingestao')
    .update({ status: 'erro', erro_msg: 'marcado pelo teste', concluido_em: new Date().toISOString() })
    .eq('tenant_id', tenant.id)
    .in('status', [...STATUS_EM_ANDAMENTO])
    .lt('criado_em', limiteJobMorto());
  chk('a marcação não estoura', !errUpd, errUpd?.message);

  chk('job travado além do limite vira erro', (await statusDe(velho))?.status === 'erro',
    JSON.stringify(await statusDe(velho)));
  chk('job em andamento DENTRO do limite não é tocado', (await statusDe(novo))?.status === 'processando',
    JSON.stringify(await statusDe(novo)));
  chk('job concluído nunca é tocado, por mais velho que seja',
    (await statusDe(pronto))?.status === 'concluido', JSON.stringify(await statusDe(pronto)));

  // ---------------------------------------------------------------------------
  console.log('\n-- 3. Dispensar: o filtro do PostgREST de verdade --\n');
  //
  // É a parte frágil. `or` com `and(...)` aninhado e timestamp ISO: escrita
  // errada devolve zero linhas em silêncio, e o botão não funciona.

  const travado = await plantar(tenant.id, 'processando', MINUTOS_JOB_MORTO + 5, 'teste-dispensar-travado');
  const trabalhando = await plantar(tenant.id, 'processando', 1, 'teste-dispensar-trabalhando');
  const falhou = await plantar(tenant.id, 'erro', 1, 'teste-dispensar-erro');
  const terminou = await plantar(tenant.id, 'concluido', MINUTOS_JOB_MORTO + 60, 'teste-dispensar-concluido');

  const dispensar = async (id) => {
    const { data, error } = await sb
      .from('jobs_ingestao')
      .delete()
      .eq('tenant_id', tenant.id)
      .eq('id', id)
      .or(filtroJobDispensavel(limiteJobMorto()))
      .select('id');
    return { erro: error?.message ?? null, apagou: (data ?? []).length };
  };

  const rTravado = await dispensar(travado);
  chk('o filtro é aceito pelo PostgREST', rTravado.erro === null, rTravado.erro ?? '');
  chk('job travado É dispensável — o bug que estava aqui', rTravado.apagou === 1, `apagou ${rTravado.apagou}`);
  chk('e some de verdade', !(await existe(travado)));

  const rTrabalhando = await dispensar(trabalhando);
  chk('job de 1 minuto NÃO é dispensável', rTrabalhando.apagou === 0, `apagou ${rTrabalhando.apagou}`);
  chk('e continua lá', await existe(trabalhando));

  const rErro = await dispensar(falhou);
  chk('job com erro segue dispensável na hora (comportamento antigo preservado)',
    rErro.apagou === 1, `apagou ${rErro.apagou}`);

  const rConcluido = await dispensar(terminou);
  chk('job concluído NUNCA é dispensável — virou documento',
    rConcluido.apagou === 0, `apagou ${rConcluido.apagou}`);
  chk('e continua lá', await existe(terminou));
} finally {
  // Limpeza por id explícito. Roda mesmo se uma asserção estourar.
  const restantes = [];
  for (const id of plantados) {
    const { error } = await sb.from('jobs_ingestao').delete().eq('id', id);
    if (error) restantes.push(id);
  }
  console.log(
    restantes.length
      ? `\n  ATENCAO: nao consegui apagar ${restantes.join(', ')}`
      : `\n  limpeza: ${plantados.length} linha(s) plantada(s) removida(s)`,
  );
}

console.log('\n' + '-'.repeat(60));
console.log(`  ${ok} passaram, ${falhas.length} falharam`);
for (const f of falhas) console.log(`  ! ${f}`);
console.log();

process.exitCode = falhas.length > 0 ? 1 : 0;
