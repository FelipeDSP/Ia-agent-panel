#!/usr/bin/env node
/**
 * teste:foto-e-kb — dois corpos de tool que nunca tiveram teste:
 * `Resposta ao Agente` (Tool - Enviar Foto) e `Consolida Resultado` (Tool -
 * Busca KB). Fatia 0 da migração (DESENHO-AGENTE-EM-CODIGO.md §4): o
 * comportamento ATUAL, executado do corpo que está no JSON, para o código
 * novo ter o que igualar.
 *
 * O que ele mede:
 *   1. foto: enviada -> frase que manda comentar e NÃO mandar outra; cada
 *      motivo do CHECK `fotos_enviadas_motivo_valido` tem texto PRÓPRIO — e a
 *      lista de motivos vem do BANCO (`pg_get_constraintdef`), não de cópia
 *      aqui: motivo novo na migração sem texto no corpo fica vermelho;
 *   2. foto: motivo desconhecido cai no fallback que nomeia o motivo e manda
 *      "não afirme que enviou"; nenhum caso devolve vazio;
 *   3. KB: zero trechos -> a string `NENHUM_RESULTADO...` (o agente sabe que
 *      precisa transferir); trechos -> numerados, com relevância a 3 casas,
 *      na ordem; `vende=true` em qualquer trecho -> AVISO DE FONTE anexado;
 *      item sem `text` é ignorado;
 *   4. sabotagens com md5: tirar `janela` do mapa -> cobertura do domínio
 *      acusa; tirar o aviso -> o caso `vende` acusa.
 *
 * Uso: npm run teste:foto-e-kb
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ler = (rel) => JSON.parse(fs.readFileSync(path.join(RAIZ, 'n8n', 'workflows', rel), 'utf8'));
const FOTO = ler('tool-enviar-foto.json').nodes.find((n) => n.name === 'Resposta ao Agente').parameters.jsCode;
const KB = ler('Tool - Busca KB Multi-Tenant.json').nodes.find((n) => n.name === 'Consolida Resultado').parameters.jsCode;
const md5 = (t) => crypto.createHash('md5').update(t, 'utf8').digest('hex').slice(0, 12);

let ok = 0;
const falhas = [];
const chk = (nome, cond, det = '') => {
  if (cond) { ok++; console.log(`  OK    ${nome}`); }
  else { falhas.push(nome); console.log(`  FALHA ${nome}${det ? ` — ${det}` : ''}`); }
};
// eslint-disable-next-line no-new-func
const rodar = (js, itens) => new Function('$input', js)({ first: () => ({ json: itens[0] }), all: () => itens.map((json) => ({ json })) });

// ===========================================================================
console.log('\n== 1. Resposta ao Agente (foto): o domínio vem do CHECK ==\n');
// ===========================================================================
const url = fs.readFileSync(path.join(RAIZ, '.env.local'), 'utf8').split(/\r?\n/)
  .find((l) => l.startsWith('SUPABASE_DB_URL=')).slice('SUPABASE_DB_URL='.length).trim().replace(/^["']|["']$/g, '');
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await c.connect();
let motivos = [];
try {
  const def = (await c.query(`select pg_get_constraintdef(oid) d from pg_constraint where conname = 'fotos_enviadas_motivo_valido'`)).rows[0]?.d ?? '';
  // `motivo = ANY (ARRAY['a'::text, 'b'::text])` ou `motivo in ('a','b')` — os dois
  // formatos que o Postgres imprime, conforme a versão.
  motivos = [...def.matchAll(/'([a-z_]+)'(?:::text)?/g)].map((m) => m[1]).filter((m) => m !== 'text');
} finally {
  await c.end();
}
chk('o CHECK existe e lista motivos (a lista não é vácua)', motivos.length >= 4, JSON.stringify(motivos));

{
  const enviada = rodar(FOTO, [{ enviada: true, produto_nome: 'Bolo de cenoura' }])[0].json.resultado;
  chk('enviada: nomeia o produto e manda comentar', /Bolo de cenoura/.test(enviada) && /Comente/.test(enviada));
  chk('enviada: manda NÃO enviar outra na sequência', /NAO envie outra foto/.test(enviada));

  const textos = {};
  for (const m of motivos) textos[m] = rodar(FOTO, [{ enviada: false, motivo: m }])[0].json.resultado;
  chk(`cada motivo do CHECK (${motivos.join(', ')}) tem texto próprio, e não o fallback`,
    motivos.every((m) => textos[m] && !/motivo nao mapeado/.test(textos[m])),
    motivos.filter((m) => /motivo nao mapeado/.test(textos[m] ?? '')).join(', '));
  chk('  ...e os textos são DIFERENTES entre si (não é "não consegui" para tudo)',
    new Set(Object.values(textos)).size === motivos.length);
  chk('janela: manda NÃO tentar de novo e NÃO se desculpar', /NAO tente de novo/.test(textos.janela ?? '') && /nao se desculpe/.test(textos.janela ?? ''));
  chk('sem_foto: diz que não há imagem e não promete depois', /sem prometer/.test(textos.sem_foto ?? ''));

  const desconhecido = rodar(FOTO, [{ enviada: false, motivo: 'marciano' }])[0].json.resultado;
  chk('motivo desconhecido: fallback nomeia o motivo', /motivo nao mapeado: marciano/.test(desconhecido));
  chk('  ...e manda não afirmar que enviou', /nao afirme que enviou/.test(desconhecido));
  const semNada = rodar(FOTO, [{}])[0].json.resultado;
  chk('sem `enviada` nem `motivo`: ainda assim devolve texto (nunca vazio)', typeof semNada === 'string' && semNada.length > 20);
}

// ===========================================================================
console.log('\n== 2. Consolida Resultado (KB) ==\n');
// ===========================================================================
{
  const zero = rodar(KB, [])[0].json.resposta;
  chk('zero trechos -> começa com NENHUM_RESULTADO (o agente transfere em vez de inventar)', /^NENHUM_RESULTADO:/.test(zero));
  const soVazios = rodar(KB, [{ text: '' }, { similarity: 0.9 }])[0].json.resposta;
  chk('itens sem `text` são ignorados -> também NENHUM_RESULTADO', /^NENHUM_RESULTADO:/.test(soVazios));

  const itens = [
    { text: 'Abrimos às 8h.', similarity: 0.91234, vende: false },
    { text: 'Entrega grátis acima de R$ 50.', similarity: 0.8, vende: false },
  ];
  const r = rodar(KB, itens)[0].json.resposta;
  chk('trechos numerados na ordem, com relevância a 3 casas', /\[Trecho 1 \| relevância 0\.912\]\nAbrimos às 8h\./.test(r) && /\[Trecho 2 \| relevância 0\.800\]\nEntrega/.test(r));
  chk('separador entre trechos', r.split('\n\n---\n\n').length === 2);
  chk('sem `vende`, NÃO há aviso de fonte', !/AVISO DE FONTE/.test(r));

  const rv = rodar(KB, [itens[0], { ...itens[1], vende: true }])[0].json.resposta;
  chk('`vende=true` em UM trecho -> AVISO DE FONTE anexado no fim', /AVISO DE FONTE \(instrucao interna/.test(rv) && rv.endsWith('nao cote preco a partir deles.'));
  chk('  ...dizendo que preço válido é o de consultar_catalogo', /consultar_catalogo/.test(rv));
}

// ===========================================================================
console.log('\n== 3. SABOTAGEM ==\n');
// ===========================================================================
{
  const alvo = /\n\s*janela:\n\s*'Voce acabou de enviar uma foto nesta conversa\./;
  if (!alvo.test(FOTO)) chk('S1 localizou o alvo', false);
  else {
    const mut = FOTO.replace(alvo, "\n  janelx:\n    'Voce acabou de enviar uma foto nesta conversa.");
    console.log(`     [mutou "janela -> janelx" no mapa: md5 ${md5(FOTO)} -> ${md5(mut)}]`);
    const t = rodar(mut, [{ enviada: false, motivo: 'janela' }])[0].json.resultado;
    chk('S1: motivo do CHECK sem texto próprio cai no fallback (a cobertura acusaria)', /motivo nao mapeado: janela/.test(t));
  }
  const alvo2 = 'vende ? texto + SEPARADOR + AVISO : texto';
  const n2 = KB.split(alvo2).length - 1;
  if (n2 !== 1) chk('S2 localizou o alvo', false, `${n2}x`);
  else {
    const mut = KB.split(alvo2).join('false ? texto + SEPARADOR + AVISO : texto');
    console.log(`     [mutou "aviso nunca": md5 ${md5(KB)} -> ${md5(mut)}]`);
    const r = rodar(mut, [{ text: 'x', similarity: 0.5, vende: true }])[0].json.resposta;
    chk('S2: sem o aviso, o caso `vende` sai sem AVISO (a asserção de cima pegaria)', !/AVISO DE FONTE/.test(r));
  }
}

console.log(`\n${'-'.repeat(62)}`);
console.log(`  ${ok} passaram, ${falhas.length} falharam`);
if (falhas.length) { for (const f of falhas) console.log(`    - ${f}`); process.exit(1); }
