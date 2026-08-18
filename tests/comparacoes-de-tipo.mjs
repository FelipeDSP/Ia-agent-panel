#!/usr/bin/env node
/**
 * COMPARAÇÃO QUE NÃO CONSEGUE SER VERDADEIRA (nem falsa) POR CAUSA DO TIPO.
 *
 * POR QUE EXISTE. Em 18/08 uma asserção nova comparou `chatwoot_account_id ===
 * 912345` e falhou sempre: a coluna é `bigint`, e o **node-postgres devolve
 * bigint como STRING** (não cabe em `Number` com segurança). Ali o erro caiu
 * para o vermelho e foi visto na hora — acusou defeito onde não havia.
 *
 * O problema é a outra metade: a mesma confusão invertida passa VERDE. Um
 * `!==` entre tipos que nunca coincidem é sempre verdadeiro, e vira "o tenant B
 * não vê o dado de A" que nunca poderia falhar. É a família das nove asserções
 * vácuas — comparação que não consegue ser falsa.
 *
 * O QUE VARRE, e por que é propriedade e não lista:
 *
 *  1. pergunta ao BANCO quais colunas são `bigint` ou `numeric`. Coluna nova
 *     entra sozinha; ninguém precisa lembrar de atualizar nada aqui;
 *  2. só acusa arquivo que fala com o banco por `pg`. Pelo supabase-js o valor
 *     chega como JSON — `bigint` vira NÚMERO, e a comparação está certa. A
 *     mesma linha é defeito num arquivo e correta no outro, e ignorar isso
 *     encheria o relatório de falso positivo até ninguém ler;
 *  3. procura `===` / `!==` entre uma dessas colunas e um literal numérico,
 *     `Number(...)`, ou outra expressão numérica.
 *
 * O QUE ELA NÃO PEGA, e vale saber para não confiar demais: a varredura é
 * textual e casa pelo NOME DA COLUNA na mesma linha. Se o valor for guardado
 * antes (`const conta = linha.chatwoot_account_id` e só depois `conta === 1`),
 * ela não vê. Cobrir isso exigiria seguir tipo por análise estática, que é
 * desproporcional aqui — o padrão do repositório é comparar direto. A varredura
 * reduz a chance, não a zera, e é assim que deve ser lida.
 *
 * COMO CONSERTAR quando acusar: `String(a) === String(b)`, ou `Number(a) === b`
 * quando o valor cabe em `Number` com folga (conta do Chatwoot cabe; id de
 * conversa do Chatwoot também, mas a garantia é do formato, não do tipo).
 *
 * Uso: npm run teste:comparacoes-tipo
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASTAS = ['tests', 'scripts'];

if (!process.env.SUPABASE_DB_URL) {
  console.error('SUPABASE_DB_URL ausente. Rode com --env-file=.env.local');
  process.exit(1);
}

let ok = 0;
const falhas = [];
const chk = (nome, cond, det = '') => {
  if (cond) { ok++; console.log(`  OK    ${nome}`); }
  else { falhas.push(`${nome}${det ? ' — ' + det : ''}`); console.log(`  FALHA ${nome}${det ? ' — ' + det : ''}`); }
};

const c = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
const { rows } = await c.query(
  `select distinct column_name, data_type
     from information_schema.columns
    where table_schema = 'public' and data_type in ('bigint', 'numeric')
    order by column_name`,
);
await c.end();

const colunas = rows.map((r) => r.column_name);

console.log('\n== Comparações de tipo (bigint/numeric vindos do driver como string) ==\n');

// Sem esta asserção, um erro na consulta deixaria a varredura vazia e o teste
// verde sem ter olhado nada — o modo de falha mais fácil de não perceber.
chk(`o banco devolveu colunas bigint/numeric para varrer (${colunas.length})`, colunas.length > 0,
  'a consulta ao information_schema voltou vazia');

/** O arquivo lê do banco por `pg` (string) ou por supabase-js (JSON/número)? */
const usaPg = (src) => /from ['"]pg['"]|require\(['"]pg['"]\)/.test(src);

const achados = [];
let arquivosPg = 0;

for (const pasta of PASTAS) {
  const dir = path.join(RAIZ, pasta);
  if (!fs.existsSync(dir)) continue;
  const arquivos = [];
  const andar = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) andar(p);
      else if (e.name.endsWith('.mjs') || e.name.endsWith('.js')) arquivos.push(p);
    }
  };
  andar(dir);

  for (const arq of arquivos) {
    const src = fs.readFileSync(arq, 'utf8');
    if (!usaPg(src)) continue;
    arquivosPg++;
    const linhas = src.split('\n');
    linhas.forEach((linha, i) => {
      // Comentário não é código. Sem isto, a própria explicação deste teste
      // (que cita `chatwoot_account_id === 912345`) viraria achado — já houve
      // regex casando com comentário neste repositório.
      const semComentario = linha.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
      if (!semComentario.trim() || semComentario.trim().startsWith('*')) return;
      for (const col of colunas) {
        if (!semComentario.includes(col)) continue;
        // `col === <numero|Number(...)>` ou `<numero> === col`
        const re = new RegExp(
          `(${col}\\s*(?:!==|===)\\s*(?:Number\\(|-?\\d))`
          + `|((?:^|[^\\w.])-?\\d[\\d_.]*\\s*(?:!==|===)\\s*[\\w.\\[\\]?]*${col})`,
        );
        if (re.test(semComentario)) {
          achados.push({ arquivo: path.relative(RAIZ, arq), linha: i + 1, col, texto: semComentario.trim().slice(0, 110) });
        }
      }
    });
  }
}

chk(`a varredura encontrou arquivos que usam pg (${arquivosPg})`, arquivosPg > 0,
  'nenhum arquivo casou com o detector de `pg` — o filtro deve estar errado');

if (achados.length) {
  console.log('');
  for (const a of achados) {
    console.log(`  ${a.arquivo}:${a.linha}  [${a.col}]`);
    console.log(`     ${a.texto}`);
  }
  console.log('');
}

chk('nenhuma comparação estrita entre coluna bigint/numeric e número, em arquivo que usa pg',
  achados.length === 0, `${achados.length} ocorrência(s) acima`);

// -------------------------------------------------------------------------
// Sabotagem: a varredura consegue achar alguma coisa?
// -------------------------------------------------------------------------
// Varredura que nunca acha nada e varredura quebrada tem a mesma cara. Esta
// planta o defeito num texto sintético e exige que o mesmo regex o encontre.
{
  const alvo = colunas[0] ?? 'conversation_id';
  const sintetico = [
    `const x = linha.${alvo} === 12345;`,
    `if (33180 !== r.rows[0].${alvo}) throw new Error('x');`,
    `// ${alvo} === 999 dentro de comentario, nao vale`,
    `const ok = String(linha.${alvo}) === String(esperado);`,
  ];
  const re = new RegExp(
    `(${alvo}\\s*(?:!==|===)\\s*(?:Number\\(|-?\\d))`
    + `|((?:^|[^\\w.])-?\\d[\\d_.]*\\s*(?:!==|===)\\s*[\\w.\\[\\]?]*${alvo})`,
  );
  const casou = sintetico.map((l) => re.test(l.replace(/\/\/.*$/, '')));
  chk('sabotagem: pega `col === 12345`', casou[0] === true);
  chk('sabotagem: pega `33180 !== ...col`', casou[1] === true);
  chk('sabotagem: IGNORA a mesma coisa dentro de comentário', casou[2] === false);
  chk('sabotagem: NÃO acusa o conserto (`String(a) === String(b)`)', casou[3] === false);
}

console.log('\n' + '-'.repeat(60));
console.log(`  ${ok} passaram, ${falhas.length} falharam`);
for (const f of falhas) console.log(`  ! ${f}`);
console.log();

process.exitCode = falhas.length > 0 ? 1 : 0;
