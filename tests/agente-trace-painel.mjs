/**
 * A tela de turnos do agente no painel (`/admin/agente`) — a parte pura.
 *
 * O que ela promete: filtros SANEADOS (nada da query string vai cru ao banco),
 * resumo correto, e cada tipo de passo com um resumo legível. A parte de RLS
 * (tenant só vê o seu) é da migração 62 e está em `teste:migracao-agente`.
 *
 *   node --import ./tests/lib/ts.mjs tests/agente-trace-painel.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lerFiltros, resumo, linhaDoPasso, corDoStatus, corDoVeredito, desde, duracaoMs, formatarDuracao, HORAS_PERMITIDAS } from '../src/lib/agente/trace.ts';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let ok = 0;
const falhas = [];
const chk = (nome, cond, det = '') => {
  if (cond) { ok++; console.log(`  OK    ${nome}`); }
  else { falhas.push(nome); console.log(`  FALHA ${nome}${det ? ` — ${det}` : ''}`); }
};

console.log('\n== 1. Filtros saneados ==\n');
{
  const f = lerFiltros({ tenant: "x' or 1=1 --", status: 'DROP', horas: '999' });
  chk('tenant não-UUID, status desconhecido e horas fora da lista -> null/null/24', f.tenantId === null && f.status === null && f.horas === 24, JSON.stringify(f));
  const g = lerFiltros({ tenant: '11111111-2222-3333-4444-555555555555', status: 'falhou', horas: '72' });
  chk('UUID, status válido e horas permitidas passam', g.tenantId === '11111111-2222-3333-4444-555555555555' && g.status === 'falhou' && g.horas === 72);
  chk('array na query (?horas=6&horas=1) usa o primeiro', lerFiltros({ horas: ['6', '1'] }).horas === 6);
  chk('HORAS_PERMITIDAS inclui 24 (o default) — contraprova de que o default é permitido', HORAS_PERMITIDAS.includes(24));
  const d = desde(24, new Date('2026-09-16T12:00:00Z'));
  chk('desde(24 h) = 24 h antes, ISO', d === '2026-09-15T12:00:00.000Z', d);
}

console.log('\n== 2. Resumo e duração ==\n');
{
  const turnos = [
    { status: 'ok', portao_veredito: 'passou', usage_entrada: 100, usage_saida: 10 },
    { status: 'falhou', portao_veredito: null, usage_entrada: null, usage_saida: null },
    { status: 'ok', portao_veredito: 'barrado_regra_1', usage_entrada: 50, usage_saida: 5 },
    { status: 'descartado', portao_veredito: null, usage_entrada: 0, usage_saida: 0 },
  ];
  const r = resumo(turnos);
  chk('total 4, ok 2, falhou 1, barrados 1, tokens 165', JSON.stringify(r) === JSON.stringify({ total: 4, ok: 2, falhou: 1, barrados: 1, tokens: 165 }), JSON.stringify(r));
  chk('duração: 4,4 s; aberto -> —', formatarDuracao(duracaoMs({ iniciado_em: '2026-09-16T12:44:42.655Z', concluido_em: '2026-09-16T12:44:47.090Z' })) === '4,4 s' && formatarDuracao(duracaoMs({ iniciado_em: 'x', concluido_em: null })) === '—');
  chk('cores: ok=success, falhou=danger, aberto=warning; portão passou=success, barrado=danger', corDoStatus('ok') === 'success' && corDoStatus('falhou') === 'danger' && corDoStatus('aberto') === 'warning' && corDoVeredito('passou') === 'success' && corDoVeredito('barrado_regra_3') === 'danger');
}

console.log('\n== 3. Uma linha por tipo de passo ==\n');
{
  const p = (tipo, nome, entrada, saida, erro = null) => ({ id: 'x', turno_id: 'y', ordem: 1, tipo, nome, entrada, saida, erro, duracao_ms: null, criado_em: '' });
  chk('modelo com tool call: "4978/18 tokens · 1 tool call(s)"', linhaDoPasso(p('modelo', 'openai#1', null, { texto: null, usage: { entrada: 4978, saida: 18 }, tool_calls: 1 })) === '4978/18 tokens · 1 tool call(s)');
  chk('modelo com texto: tokens + o texto', linhaDoPasso(p('modelo', 'openai#2', null, { texto: 'Oi!', usage: { entrada: 5, saida: 2 }, tool_calls: 0 })) === '5/2 tokens · Oi!');
  chk('tool: o texto que voltou ao modelo', linhaDoPasso(p('tool', 'consultar_catalogo', { termo: null }, { texto: 'Catálogo: 30 itens' })) === 'Catálogo: 30 itens');
  chk('portão: o veredito', linhaDoPasso(p('portao', 'aplica-portao.js', {}, { veredito: 'passou' })) === 'veredito: passou');
  chk('entrada (prompt): o texto do cliente', linhaDoPasso(p('entrada', 'prompt', { texto: 'quais produtos?' }, null)) === 'quais produtos?');
  chk('memória: N mensagens', linhaDoPasso(p('memoria', 'api_agente_memoria', {}, { mensagens: 6 })) === '6 mensagens');
  chk('erro vence tudo', linhaDoPasso(p('falha', 'transcrever', {}, null, 'TimeoutError: x')) === 'TimeoutError: x');
}

console.log('\n== 4. As páginas existem e o menu do admin aponta para elas ==\n');
{
  const lista = fs.existsSync(path.join(RAIZ, 'src/app/(app)/admin/agente/page.tsx'));
  const turno = fs.existsSync(path.join(RAIZ, 'src/app/(app)/admin/agente/[turnoId]/page.tsx'));
  const sidebar = fs.readFileSync(path.join(RAIZ, 'src/components/sidebar.tsx'), 'utf8');
  chk('/admin/agente e /admin/agente/[turnoId] existem', lista && turno);
  chk('o menu do admin tem o item Agente', /href: '\/admin\/agente'/.test(sidebar));
  const pagina = fs.readFileSync(path.join(RAIZ, 'src/app/(app)/admin/agente/page.tsx'), 'utf8');
  chk('a lista exige super_admin e usa lerFiltros (não lê a query crua)', /exigirSuperAdmin\(\)/.test(pagina) && /lerFiltros\(await searchParams\)/.test(pagina));
}

console.log(`\n${ok} passaram, ${falhas.length} falharam\n`);
if (falhas.length) process.exit(1);
