/**
 * §5.8 do desenho — DIFF DE CUSTO: tokens REAIS (usage da OpenAI) × a
 * ESTIMATIVA do `Estima Tokens`, nos MESMOS turnos.
 *
 * Lê o trace do agente em código: `agente_turnos` (real: `usage_entrada`,
 * `usage_saida`) e o passo `registro:estimativa_n8n` de cada turno (a fórmula
 * do nó, calculada no turno — `agente/src/turno/estimativa.ts`). É o dado que
 * decide a §3 do desenho (rateio por componente): se a estimativa erra pouco
 * e de forma estável, o rateio pode viver dela; se erra muito ou depende do
 * turno, precisa do `usage`.
 *
 * Só leitura. Passos têm retenção (TRACE_RETENCAO_DIAS, 30 por padrão): a
 * janela útil é essa; o veredito vai para o doc quando houver volume.
 *
 *   npm run diff:custo            (últimos 30 dias, todos os tenants em código)
 *   npm run diff:custo -- 7       (últimos 7 dias)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIAS = Math.max(1, Number(process.argv[2]) || 30);

const url = process.env.SUPABASE_DB_URL ?? fs.readFileSync(path.join(RAIZ, '.env.local'), 'utf8')
  .split(/\r?\n/).find((l) => l.startsWith('SUPABASE_DB_URL='))
  ?.slice('SUPABASE_DB_URL='.length).trim().replace(/^["']|["']$/g, '');
if (!url) { console.error('SUPABASE_DB_URL ausente'); process.exit(2); }

const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await c.connect();

try {
  const { rows } = await c.query(`
    select x.slug, t.id, t.conversation_id conv, t.perfil, t.chamadas_modelo chamadas, t.tools_chamadas tools,
           t.usage_entrada real_entrada, t.usage_saida real_saida,
           (p.saida -> 'estimado' ->> 'entrada')::int est_entrada,
           (p.saida -> 'estimado' ->> 'saida')::int est_saida,
           p.saida -> 'estimado' -> 'componentes' comp,
           t.iniciado_em
      from public.agente_turnos t
      join public.tenants x on x.id = t.tenant_id
      join public.agente_passos p on p.turno_id = t.id and p.tenant_id = t.tenant_id and p.nome = 'estimativa_n8n'
     where t.status = 'ok' and t.usage_entrada > 0
       and t.iniciado_em > now() - ($1::int || ' days')::interval
     order by t.iniciado_em`, [DIAS]);

  console.log(`\n== Diff de custo (§5.8) — ${rows.length} turno(s) com real E estimativa nos últimos ${DIAS} dia(s) ==\n`);
  if (rows.length === 0) {
    console.log('  Nenhum turno ainda. O passo `estimativa_n8n` entrou no código em 16/09/2026; turnos anteriores não têm a estimativa.\n');
    process.exit(0);
  }

  const pct = (est, real) => (real ? Math.round(((est - real) / real) * 1000) / 10 : null);
  const linhas = rows.map((r) => ({
    tenant: r.slug, conv: Number(r.conv), perfil: r.perfil, chamadas: r.chamadas, tools: r.tools,
    real_in: r.real_entrada, est_in: r.est_entrada, desvio_in: pct(r.est_entrada, r.real_entrada),
    real_out: r.real_saida, est_out: r.est_saida, desvio_out: pct(r.est_saida, r.real_saida),
    quando: r.iniciado_em.toISOString().slice(5, 16).replace('T', ' '),
  }));
  console.table(linhas);

  // Agregados por número de chamadas — a fórmula é cega para o TAMANHO do
  // resultado da tool, então o erro deve crescer com `chamadas`.
  const grupos = new Map();
  for (const l of linhas) {
    const g = grupos.get(l.chamadas) ?? { chamadas: l.chamadas, n: 0, desvios: [] };
    g.n++; g.desvios.push(l.desvio_in); grupos.set(l.chamadas, g);
  }
  const mediana = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  console.log('\n-- desvio da ENTRADA por número de chamadas ao modelo (estimado − real, % do real) --\n');
  console.table([...grupos.values()].sort((a, b) => a.chamadas - b.chamadas).map((g) => ({
    chamadas: g.chamadas, turnos: g.n,
    mediana_pct: mediana(g.desvios), min_pct: Math.min(...g.desvios), max_pct: Math.max(...g.desvios),
  })));

  const todos = linhas.map((l) => l.desvio_in);
  const abs = todos.map(Math.abs);
  console.log(`\n  entrada: mediana ${mediana(todos)}%  |  |desvio| mediano ${mediana(abs)}%  |  pior ${Math.max(...abs)}%`);
  console.log(`  saída:   mediana ${mediana(linhas.map((l) => l.desvio_out ?? 0))}%`);
  console.log('\n  Leitura: negativo = a estimativa SUBESTIMA. A fórmula não vê o tamanho do retorno das tools nem o');
  console.log('  formato do histórico que o modelo recebe — os dois puxam para baixo. O rateio da §3 decide com isto.\n');
} finally {
  await c.end();
}
