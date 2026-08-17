#!/usr/bin/env node
/**
 * A tela de conhecimento conta a mesma coisa que o banco.
 *
 * POR QUE EXISTE. Em 17/08/2026 `/painel/conhecimento` do `emporio` mostrou **1
 * documento** com **2** no banco (81 chunks). O invisível — "Lei da Prevenção ou
 * Lei 15.377/2026", subido por engano naquele tenant — não podia ser removido
 * pela tela, porque a tela só oferece remover o que ela lista, e o agente
 * continuava buscando nele. Foi preciso apagar por SQL.
 *
 * É a mesma família do rótulo "669 documentos": a tela dizendo uma coisa e o
 * banco outra. A diferença é que ali o erro era de nome (chunks contados como
 * documentos) e aqui é de CONTAGEM — e contagem errada esconde dado do cliente.
 *
 * IMPORTA A FONTE (`src/lib/conhecimento/agrupar.ts`), que é a mesma função que
 * o Server Component chama. Antes a lógica era inline no `page.tsx` e nenhum
 * teste alcançava: a única forma de conferir a lista era abrir o navegador.
 *
 * TRÊS ASSERÇÕES, e a segunda existe porque a primeira tem um buraco:
 *
 *  1. `documentos na tela == count(distinct origem)` — a que foi pedida.
 *  2. Nenhuma `origem` com dois `metadata.arquivo` diferentes. A (1) NÃO pega
 *     este caso: com dois uploads na mesma origem, tela e `count(distinct)`
 *     concordam em 1, as duas erradas do mesmo jeito. Medido, não suposto.
 *  3. Nenhum chunk vivo com `origem` nula. A tela mostraria "(sem origem)" e
 *     `excluirDocumento` filtra `.eq('origem', ...)`, que nunca casa com null —
 *     uma linha que existe e não pode ser apagada pelo painel.
 *
 * Roda contra TODOS os tenants com base, não contra um seed: o defeito apareceu
 * num tenant de cliente, e é lá que a contagem precisa bater.
 *
 * Uso: npm run teste:conhecimento
 */

import { createClient } from '@supabase/supabase-js';

import { carregarEnv } from '../scripts/lib/env.mjs';
import {
  SEM_ORIGEM,
  agruparDocumentos,
  origensComNomesConflitantes,
} from '../src/lib/conhecimento/agrupar.ts';

carregarEnv();

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SECRETA = process.env.SUPABASE_SECRET_KEY;
if (!URL || !SECRETA) {
  console.error('\n  Faltam variáveis no .env.local.\n');
  process.exit(64);
}

const admin = createClient(URL, SECRETA, { auth: { autoRefreshToken: false, persistSession: false } });

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

console.log('\n== A lista de documentos bate com o banco? ==\n');

const { data: tenants, error: erroT } = await admin
  .from('tenants')
  .select('id, slug')
  .is('deletado_em', null)
  .order('slug');
if (erroT) throw new Error(`carregar tenants: ${erroT.message}`);

let comBase = 0;

for (const t of tenants ?? []) {
  // A QUERY DA PÁGINA, campo por campo. Se ela mudar lá e não aqui, o teste
  // deixa de medir a tela — por isso a asserção de "achou chunks" abaixo.
  const { data: chunks, error } = await admin
    .from('kb_documentos')
    .select('origem, metadata, criado_em')
    .eq('tenant_id', t.id)
    .is('deletado_em', null)
    .order('criado_em', { ascending: false });

  if (error) {
    checar(`${t.slug}: a query da lista não erra`, false, `${error.code}: ${error.message}`);
    continue;
  }
  if ((chunks ?? []).length === 0) continue;
  comBase++;

  // A VERDADE DO BANCO, por count exato — não pela mesma lista que estou
  // testando. Contar o que já trouxe seria a asserção concordando consigo mesma.
  const origens = new Set();
  let pagina = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { data, error: e2 } = await admin
      .from('kb_documentos')
      .select('origem')
      .eq('tenant_id', t.id)
      .is('deletado_em', null)
      .range(pagina * 1000, pagina * 1000 + 999);
    if (e2) throw new Error(`contar origens de ${t.slug}: ${e2.message}`);
    for (const r of data ?? []) origens.add(r.origem ?? SEM_ORIGEM);
    if ((data ?? []).length < 1000) break;
    pagina++;
  }

  const documentos = agruparDocumentos(chunks);

  checar(
    `${t.slug}: documentos na tela == origens no banco`,
    documentos.length === origens.size,
    `tela=${documentos.length} banco=${origens.size}`,
  );

  const conflitos = origensComNomesConflitantes(chunks);
  checar(
    `${t.slug}: nenhuma origem esconde dois documentos`,
    conflitos.length === 0,
    conflitos.map((c) => `${c.origem} -> ${c.nomes.join(' + ')}`).join(' | '),
  );

  const nulas = (chunks ?? []).filter((c) => c.origem == null).length;
  checar(
    `${t.slug}: nenhum chunk vivo sem origem`,
    nulas === 0,
    `${nulas} chunk(s) — apareceriam como "${SEM_ORIGEM}" e o painel não conseguiria removê-los`,
  );

  // A soma dos chunks por documento tem de fechar com o total. Se algum chunk
  // não entrar em nenhum grupo, some da tela sem ninguém somar de novo.
  const somaChunks = documentos.reduce((s, d) => s + d.chunks, 0);
  checar(
    `${t.slug}: a soma dos chunks por documento fecha com o total`,
    somaChunks === (chunks ?? []).length,
    `soma=${somaChunks} total=${(chunks ?? []).length}`,
  );
}

// Sem isto, um erro no filtro deixaria o laço sem iteração nenhuma e o teste
// passaria verde tendo medido zero tenants — a vacuidade que este repo varreu.
checar(
  `a varredura encontrou tenants com base de conhecimento (${comBase})`,
  comBase > 0,
  'nenhum tenant tem chunk — o filtro deve estar errado',
);

console.log(`\n${'-'.repeat(60)}`);
console.log(`  ${passou} passaram, ${falhas.length} falharam\n`);
if (falhas.length) {
  for (const f of falhas) console.log(`   - ${f}`);
  console.log('');
  process.exitCode = 1;
}
