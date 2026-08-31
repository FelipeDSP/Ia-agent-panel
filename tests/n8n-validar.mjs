#!/usr/bin/env node
/**
 * O validador de workflow roda, e as duas regras novas sabem ficar vermelhas.
 *
 * POR QUE EXISTE. `scripts/n8n-validar.mjs` acumulou nove regras, cada uma
 * escrita depois de um defeito que mordeu — e nao era executado por ninguem em
 * ciclo nenhum. Uma regra que ninguem roda nao e guarda, e uma lista de coisas
 * que ja aconteceram.
 *
 * O caso que motivou: o no `Consulta Pausa` do agente principal nasceu SEM
 * credencial em 21/08, no mesmo commit que criou o portao de pausa, e ficou dez
 * dias assim. Quem achou foi o diff contra a instancia em 31/08, por acaso. A
 * regra 8 existe para que da proxima vez o achado seja aqui, e nao dez dias
 * depois num arquivo que alguem ia importar.
 *
 * SABOTAGEM OBRIGATORIA. As duas regras novas sao exercitadas contra copias
 * mutadas em pasta temporaria — e cada sabotagem confirma primeiro que MUTOU,
 * porque "rodou e nao falhou" com a mutacao que nao aplicou e falso verde.
 *
 * Uso: npm run teste:n8n-validar
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RAIZ = fileURLToPath(new URL('../', import.meta.url));
const DIR = path.join(RAIZ, 'n8n', 'workflows');
const VALIDADOR = path.join(RAIZ, 'scripts', 'n8n-validar.mjs');

let passou = 0;
const falhas = [];
const chk = (nome, ok, det = '') => {
  if (ok) { passou++; console.log(`  OK    ${nome}`); }
  else { falhas.push(`${nome}${det ? ` — ${det}` : ''}`); console.log(`  FALHA ${nome}${det ? ` — ${det}` : ''}`); }
};

/** Roda o validador. Nao estoura: o exit 1 dele e RESULTADO, nao acidente. */
function validar(arquivos) {
  try {
    const saida = execFileSync(process.execPath, [VALIDADOR, ...arquivos], { encoding: 'utf8' });
    return { code: 0, saida };
  } catch (e) {
    return { code: e.status ?? -1, saida: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

const arquivos = fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => path.join(DIR, f));

console.log(`\n== Validador de workflows — ${arquivos.length} arquivos ==\n`);
console.log('-- 1. O repo passa hoje --\n');

// Guarda de vacuidade: pasta vazia faria tudo abaixo passar sem medir nada.
chk('achou os workflows do repo', arquivos.length >= 9, `${arquivos.length} arquivo(s)`);

const hoje = validar(arquivos);
chk('os workflows versionados passam no validador', hoje.code === 0,
  hoje.saida.split(/\r?\n/).filter((l) => l.includes('PROBLEMA')).join(' | '));

// O AVISO informa sem reprovar — e a diferenca entre os dois e a propriedade
// que separa "placeholder ja decidido e adiado" de "placeholder novo".
chk('o placeholder conhecido sai como AVISO, nao como PROBLEMA',
  /AVISO\s+"Assina URL"/.test(hoje.saida) && !/PROBLEMA.*FOTO_SECRET_HEADER/.test(hoje.saida));

console.log('\n-- 2. SABOTAGEM: regra 8, no de banco sem credencial --\n');
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'n8nval-'));
  const alvo = path.join(tmp, 'agente-principal.json');
  const wf = JSON.parse(fs.readFileSync(path.join(DIR, 'agente-principal.json'), 'utf8'));
  const no = wf.nodes.find((n) => n.name === 'Consulta Pausa');

  chk('o alvo da sabotagem existe e HOJE tem credencial', Boolean(no && no.credentials && no.credentials.postgres),
    no ? JSON.stringify(no.credentials ?? null) : '(no ausente)');

  delete no.credentials;
  fs.writeFileSync(alvo, JSON.stringify(wf, null, 2));

  // CONFIRME QUE A MUTACAO ENTROU antes de acreditar no resultado.
  const relido = JSON.parse(fs.readFileSync(alvo, 'utf8'));
  const noRelido = relido.nodes.find((n) => n.name === 'Consulta Pausa');
  chk('a sabotagem 8 entrou no arquivo (a credencial sumiu)', noRelido.credentials === undefined);

  const r = validar([alvo]);
  chk('regra 8 REPROVA no postgres sem credencial', r.code === 1 && /SEM credencial/.test(r.saida),
    `code=${r.code}`);
  chk('e a mensagem nomeia o no, para nao obrigar a caçar', /"Consulta Pausa"/.test(r.saida));
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('\n-- 3. SABOTAGEM: regra 9, id de credencial que e placeholder --\n');
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'n8nval-'));
  const alvo = path.join(tmp, 'tool-fechar-pedido.json');
  const wf = JSON.parse(fs.readFileSync(path.join(DIR, 'tool-fechar-pedido.json'), 'utf8'));
  const no = wf.nodes.find((n) => n.credentials && Object.keys(n.credentials).length);

  chk('o alvo da sabotagem 9 tem credencial com id de verdade',
    Boolean(no) && /^[A-Za-z0-9]{16}$/.test(Object.values(no.credentials)[0].id ?? ''),
    no ? JSON.stringify(Object.values(no.credentials)[0]) : '(sem no com credencial)');

  const tipo = Object.keys(no.credentials)[0];
  no.credentials[tipo].id = 'PREENCHER_DEPOIS';
  fs.writeFileSync(alvo, JSON.stringify(wf, null, 2));

  const relido = JSON.parse(fs.readFileSync(alvo, 'utf8'));
  const idRelido = Object.values(relido.nodes.find((n) => n.name === no.name).credentials)[0].id;
  chk('a sabotagem 9 entrou no arquivo', idRelido === 'PREENCHER_DEPOIS', `id=${idRelido}`);

  const r = validar([alvo]);
  chk('regra 9 REPROVA id que nao tem forma de id do n8n', r.code === 1 && /PREENCHER_DEPOIS/.test(r.saida),
    `code=${r.code}`);

  // CONTRAPROVA: um id de verdade NAO pode reprovar, senao a regra 9 estaria
  // reprovando tudo e o vermelho acima nao diria nada sobre o placeholder.
  const limpo = path.join(tmp, 'limpo.json');
  const wf2 = JSON.parse(fs.readFileSync(path.join(DIR, 'tool-fechar-pedido.json'), 'utf8'));
  fs.writeFileSync(limpo, JSON.stringify(wf2, null, 2));
  const r2 = validar([limpo]);
  chk('CONTRAPROVA: o mesmo arquivo sem a sabotagem passa', r2.code === 0,
    r2.saida.split(/\r?\n/).filter((l) => l.includes('PROBLEMA')).join(' | '));
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${'-'.repeat(60)}`);
console.log(`  ${passou} passaram, ${falhas.length} falharam`);
if (falhas.length) {
  console.log('\n  FALHAS:');
  for (const f of falhas) console.log(`    - ${f}`);
  process.exit(1);
}
