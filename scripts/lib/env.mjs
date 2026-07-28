/**
 * Carrega .env.local e diz de onde veio cada valor.
 *
 * Precedencia: variavel ja definida no ambiente vence o arquivo. E o padrao
 * de todo carregador de .env, e normalmente e o que se quer — mas quando a
 * variavel do shell esta obsoleta, o arquivo e ignorado em silencio e o erro
 * que aparece nao tem relacao aparente com a causa.
 *
 * Aconteceu aqui: um SUPABASE_SECRET_KEY antigo na sessao do PowerShell
 * sobrepunha a chave correta do arquivo, e o Supabase respondia
 * "unrecognized JWT kid <nil> for algorithm ES256". Por isso o aviso abaixo.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function carregarEnv({ silencioso = false } = {}) {
  const arquivo = path.join(RAIZ, '.env.local');
  if (!fs.existsSync(arquivo)) return { origens: {}, conflitos: [] };

  const origens = {};
  const conflitos = [];

  for (const linha of fs.readFileSync(arquivo, 'utf8').split(/\r?\n/)) {
    const texto = linha.trim();
    if (!texto || texto.startsWith('#')) continue;

    const sep = texto.indexOf('=');
    if (sep === -1) continue;

    const chave = texto.slice(0, sep).trim();
    let valor = texto.slice(sep + 1).trim();
    if (/^(".*"|'.*')$/s.test(valor)) valor = valor.slice(1, -1);

    if (chave in process.env) {
      origens[chave] = 'ambiente';
      if (process.env[chave] !== valor) conflitos.push(chave);
    } else {
      process.env[chave] = valor;
      origens[chave] = 'arquivo';
    }
  }

  if (conflitos.length && !silencioso) {
    console.warn(
      `\n  AVISO: ${conflitos.join(', ')} vem da variavel de ambiente, ` +
        `nao do .env.local,\n  e os valores diferem. A variavel do shell vence.\n` +
        `  Para usar o arquivo:  Remove-Item Env:\\${conflitos[0]}\n`,
    );
  }

  return { origens, conflitos };
}

/** Fim de execucao legivel, sem abortar o Node com handle aberto. */
export class ErroDeUso extends Error {}

export function exigirVariavel(nome, { minimo = 1 } = {}) {
  const valor = process.env[nome];
  if (!valor) throw new ErroDeUso(`${nome} ausente no .env.local`);
  if (valor.includes('COLE_AQUI') || valor.length < minimo) {
    throw new ErroDeUso(
      `${nome} ainda esta com o valor de exemplo do .env.local.\n` +
        `  Valor atual: "${valor}"`,
    );
  }
  return valor;
}
