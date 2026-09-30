/**
 * "Chamou atendente" (fase 0 do ciclo de aprendizado) — derivação e isolamento.
 *
 * Duas metades, porque as duas erram de jeitos diferentes:
 *
 *  1. a DERIVAÇÃO (`chamadasDeAtendente`, pura): passo sem resumo não vira
 *     linha; `disponivel` decide o desfecho; a conversa sai do turno embutido,
 *     que o Supabase devolve ora como objeto, ora como array de um;
 *  2. o ISOLAMENTO, contra o banco de verdade: um tenant não enxerga a chamada
 *     do outro. Com CONTRAPROVA — o teste semeia a transferência no tenant B,
 *     confirma que ela existe, e só então afirma que A não a alcança. Sem a
 *     contraprova, "A não vê nada" é verdade mesmo com a RLS desligada.
 *
 * Tudo em transação abortada, com tenants criados aqui (nada de slug de seed).
 *
 *   npm run teste:chamadas-atendente
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { chamadasDeAtendente, tituloSugerido, rascunhoDeEntrada } = await import(
  new URL('../src/lib/conhecimento/lacunas.ts', import.meta.url).href
);

let ok = 0;
const falhas = [];
const chk = (nome, cond, det = '') => {
  if (cond) { ok++; console.log(`  OK    ${nome}`); }
  else { falhas.push(nome); console.log(`  FALHA ${nome}${det ? ` — ${det}` : ''}`); }
};

console.log('\n== 1. A derivação ==\n');
{
  const passo = (resumo, disponivel, conv, comoArray = false) => ({
    criado_em: '2026-09-30T12:00:00Z',
    entrada: resumo === null ? null : { resumo },
    saida: { diagnostico: { disponivel, pausou: disponivel } },
    agente_turnos: comoArray ? [{ conversation_id: conv }] : { conversation_id: conv },
  });
  const r = chamadasDeAtendente([
    passo('Cliente quer saber o prazo do certificado', true, 51),
    passo('Cliente pediu segunda via do boleto', false, '52', true),
    passo(null, true, 53),
    passo('   ', true, 54),
  ]);
  chk('descarta passo sem resumo (null e só-espaços): 4 entram, 2 saem', r.length === 2, JSON.stringify(r.map((x) => x.resumo)));
  chk('disponivel=true -> transferiu; false -> fora_do_horario', r[0].desfecho === 'transferiu' && r[1].desfecho === 'fora_do_horario');
  chk('conversa sai do turno embutido, como objeto OU como array de um', r[0].conversationId === 51 && r[1].conversationId === 52);
  chk('lista vazia e null não quebram', chamadasDeAtendente([]).length === 0 && chamadasDeAtendente(null).length === 0);
  const semConv = chamadasDeAtendente([{ criado_em: 'x', entrada: { resumo: 'a' }, saida: null, agente_turnos: null }]);
  chk('sem turno: conversationId null e desfecho fora_do_horario (saida ausente não vira "transferiu")',
    semConv[0].conversationId === null && semConv[0].desfecho === 'fora_do_horario');
}

console.log('\n== 2. Título e rascunho ==\n');
{
  chk('título: primeira frase, sem ponto final, no limite de 70', tituloSugerido('Cliente quer o prazo do certificado. E também o custo.') === 'Cliente quer o prazo do certificado');
  chk('título: resumo enorme sem pontuação é cortado em 70', tituloSugerido('a'.repeat(200)).length === 70);
  chk('título: resumo vazio tem fallback', tituloSugerido('   ') === 'Dúvida de cliente');
  const rasc = rascunhoDeEntrada('Cliente  quer\no prazo');
  chk('rascunho traz a PERGUNTA e deixa a resposta em branco (nunca chuta)', rasc.startsWith('Pergunta do cliente: Cliente quer o prazo') && rasc.trimEnd().endsWith('Resposta:'));
}

console.log('\n== 3. Isolamento, contra o banco ==\n');
const url = process.env.SUPABASE_DB_URL ?? fs.readFileSync(path.join(RAIZ, '.env.local'), 'utf8')
  .split(/\r?\n/).find((l) => l.startsWith('SUPABASE_DB_URL='))?.slice('SUPABASE_DB_URL='.length).trim().replace(/^["']|["']$/g, '');
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await c.connect();
await c.query('begin');
const um = async (sql, p = []) => (await c.query(sql, p)).rows[0];

try {
  const T = {};
  for (const s of ['a', 'b']) T[s] = (await um(`insert into public.tenants (slug, nome) values ($1, $2) returning id`, [`z-teste-chamadas-${s}`, `Teste chamadas ${s}`])).id;
  // Uma transferência em cada tenant, com resumo distinguível.
  const semear = async (t, resumo, conv) => {
    const turno = await um(`insert into public.agente_turnos (tenant_id, conversation_id, acao, status, modelo, perfil)
      values ($1, $2, 'processar', 'ok', 'gpt-4.1-mini', 'basico') returning id`, [t, conv]);
    await c.query(`insert into public.agente_passos (tenant_id, turno_id, ordem, tipo, nome, entrada, saida)
      values ($1, $2, 1, 'tool', 'transferir_humano', $3::jsonb, $4::jsonb)`,
      [t, turno.id, JSON.stringify({ resumo }), JSON.stringify({ diagnostico: { disponivel: true, pausou: true } })]);
  };
  await semear(T.a, 'SEGREDO-DE-A: prazo do certificado', 901);
  await semear(T.b, 'SEGREDO-DE-B: segunda via do boleto', 902);

  const comoTenant = async (tenantId) => {
    await c.query('savepoint sp');
    await c.query('set local role authenticated');
    await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ role: 'authenticated', app_metadata: { papel: 'tenant_admin', tenant_id: tenantId } })]);
    const r = await c.query(`select p.entrada->>'resumo' resumo from public.agente_passos p where p.nome = 'transferir_humano' and p.entrada->>'resumo' like 'SEGREDO-DE-%'`);
    await c.query('rollback to savepoint sp');
    return r.rows.map((x) => x.resumo);
  };
  const vistoPorA = await comoTenant(T.a);
  const vistoPorB = await comoTenant(T.b);
  chk('CONTRAPROVA: a chamada de B existe mesmo (B a enxerga) — sem isto a asserção seguinte é vácua',
    vistoPorB.length === 1 && vistoPorB[0].startsWith('SEGREDO-DE-B'), JSON.stringify(vistoPorB));
  chk('A vê a própria chamada e NENHUMA de B', vistoPorA.length === 1 && vistoPorA[0].startsWith('SEGREDO-DE-A'), JSON.stringify(vistoPorA));
  chk('e a derivação em cima do que A enxerga não inventa linha de B',
    chamadasDeAtendente(vistoPorA.map((r) => ({ criado_em: 'x', entrada: { resumo: r }, saida: null, agente_turnos: null })))
      .every((x) => !x.resumo.includes('SEGREDO-DE-B')));

  // A tela lê `nome = 'transferir_humano'`; o passo do portão tem outro nome e
  // não pode entrar (é fabricação barrada, não dúvida de cliente).
  const turnoP = await um(`insert into public.agente_turnos (tenant_id, conversation_id, acao, status, modelo, perfil) values ($1, 903, 'processar', 'ok', 'gpt-4.1-mini', 'vendas') returning id`, [T.a]);
  await c.query(`insert into public.agente_passos (tenant_id, turno_id, ordem, tipo, nome, entrada, saida) values ($1, $2, 1, 'tool', 'transferir_humano:portao', $3::jsonb, null)`,
    [T.a, turnoP.id, JSON.stringify({ resumo: 'SEGREDO-DE-A: portão' })]);
  const soDaTool = await um(`select count(*)::int n from public.agente_passos where tenant_id=$1 and nome = 'transferir_humano'`, [T.a]);
  chk('o passo do portão (transferir_humano:portao) não conta como chamada de atendente', soDaTool.n === 1, String(soDaTool.n));
} finally {
  await c.query('rollback');
  await c.end();
}

console.log(`\n${ok} passaram, ${falhas.length} falharam\n`);
if (falhas.length) process.exit(1);
