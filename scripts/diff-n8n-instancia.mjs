#!/usr/bin/env node
/**
 * Compara os workflows DA INSTÂNCIA com os arquivos DO REPOSITÓRIO.
 *
 * POR QUE EXISTE. Em 18/08/2026 descobriu-se, por acaso — alguém reparou num
 * print —, que o nó `OpenAI Chat Model` da instância roda com
 * `responsesApiEnabled: true`, campo que NÃO existe no JSON versionado. Não é
 * default do nó: default não é persistido. É ajuste feito na UI e nunca
 * commitado.
 *
 * A consequência é a que assusta: o próximo `gerar-principal.mjs` seguido de
 * import DESLIGA a Responses API em silêncio, porque o arquivo do repositório
 * não tem o campo. Ninguém notaria pelo comportamento do agente — notaria
 * semanas depois, se notasse.
 *
 * E havia um buraco de verificação por trás: `n8n:sincronia` compara o ARQUIVO
 * com o GERADOR. Nada comparava a INSTÂNCIA com o arquivo. É a terceira classe
 * de deriva do projeto, depois da Edge Function que ficou 10 dias fora do
 * commit e do nome de migração fora do ledger.
 *
 * COMO AUTENTICA. Pela API pública do n8n, com chave criada em
 * Settings → n8n API. NÃO usa a sessão do navegador de propósito: sessão expira
 * (a desta instância expirou no meio da investigação), exige humano logado e
 * não roda em CI. No `.env.local`:
 *
 *   N8N_URL=https://n8n.chatyou.chat
 *   N8N_API_KEY=<a chave>
 *
 * Uso:
 *   node --env-file=.env.local scripts/diff-n8n-instancia.mjs
 *   node --env-file=.env.local scripts/diff-n8n-instancia.mjs --json
 *
 * Sai com código 1 se houver divergência — serve de teste.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(RAIZ, 'n8n', 'workflows');

/*
 * O QUE É VOLÁTIL, e por que cada um.
 *
 * Ignorar de menos afoga o relatório em ruído e ninguém lê; ignorar de mais
 * esconde deriva de verdade. A regra: só entra aqui o que muda sem que o
 * COMPORTAMENTO mude. `responsesApiEnabled` jamais entraria — muda o endpoint.
 */
export const CAMPOS_NO_VOLATEIS = new Set([
  'position',    // arrastar nó no canvas não muda o que ele faz
  'id',          // uuid do nó; o import pode regravar
  'webhookId',   // gerado pela instância
  'notesInFlow', // enfeite visual
  'notes',
]);

export const CAMPOS_WF_VOLATEIS = new Set([
  'id', 'versionId', 'createdAt', 'updatedAt', 'active', 'tags', 'pinData',
  'meta', 'staticData', 'shared', 'homeProject', 'scopes', 'triggerCount',
  'isArchived', 'usedCredentials',
]);

/** Achata objeto em caminhos `a.b.0.c` -> valor primitivo. */
export function achatar(v, prefixo = '', saida = {}) {
  if (v === null || typeof v !== 'object') { saida[prefixo] = v; return saida; }
  if (Array.isArray(v)) {
    if (v.length === 0) saida[prefixo] = '[]';
    v.forEach((x, i) => achatar(x, prefixo ? `${prefixo}.${i}` : String(i), saida));
    return saida;
  }
  const chaves = Object.keys(v);
  if (chaves.length === 0) { saida[prefixo] = '{}'; return saida; }
  for (const k of chaves) achatar(v[k], prefixo ? `${prefixo}.${k}` : k, saida);
  return saida;
}

/** Nó sem o volátil, achatado, pronto para comparar campo a campo. */
export function normalizarNo(n) {
  const limpo = {};
  for (const k of Object.keys(n)) {
    if (CAMPOS_NO_VOLATEIS.has(k)) continue;
    // credencial: compara pelo NOME, não pelo id (o id é da instância)
    if (k === 'credentials') {
      limpo.credentials = Object.fromEntries(
        Object.entries(n.credentials || {}).map(([tipo, c]) => [tipo, c && c.name ? c.name : c]),
      );
      continue;
    }
    limpo[k] = n[k];
  }
  return achatar(limpo);
}

/** Compara dois workflows já carregados. Puro: é o que o teste exercita. */
export function compararWorkflow(wfRepo, wfInstancia) {
  const difs = [];
  const nosRepo = new Map((wfRepo.nodes || []).map((n) => [n.name, n]));
  const nosInst = new Map((wfInstancia.nodes || []).map((n) => [n.name, n]));

  for (const nomeNo of new Set([...nosRepo.keys(), ...nosInst.keys()])) {
    const a = nosRepo.get(nomeNo);
    const b = nosInst.get(nomeNo);
    if (!a) { difs.push({ no: nomeNo, tipo: 'nó só na INSTÂNCIA' }); continue; }
    if (!b) { difs.push({ no: nomeNo, tipo: 'nó só no REPO' }); continue; }
    const pa = normalizarNo(a);
    const pb = normalizarNo(b);
    for (const chave of new Set([...Object.keys(pa), ...Object.keys(pb)])) {
      if (JSON.stringify(pa[chave]) === JSON.stringify(pb[chave])) continue;
      difs.push({
        no: nomeNo,
        campo: chave,
        repo: pa[chave] === undefined ? '(ausente)' : String(pa[chave]).slice(0, 90),
        instancia: pb[chave] === undefined ? '(ausente)' : String(pb[chave]).slice(0, 90),
      });
    }
  }

  if (JSON.stringify(wfRepo.connections) !== JSON.stringify(wfInstancia.connections)) {
    difs.push({ no: '(conexões)', campo: 'connections', repo: 'ver arquivo', instancia: 'diverge' });
  }
  return difs;
}

// ---------------------------------------------------------------------------
// Daqui para baixo só roda quando este arquivo É o programa. As funções acima
// são importadas por `tests/diff-n8n.mjs`, que prova a regra de volátil SEM
// tocar na instância — foi o que permitiu escrever isto antes de haver chave.
// ---------------------------------------------------------------------------
const EH_PROGRAMA =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (EH_PROGRAMA) {
  const soJson = process.argv.includes('--json');
  const URL_BASE = (process.env.N8N_URL || '').replace(/\/+$/, '');
  const CHAVE = process.env.N8N_API_KEY;

  if (!URL_BASE || !CHAVE) {
    console.error(
      '\nFaltam N8N_URL e/ou N8N_API_KEY no .env.local.\n' +
      'Crie a chave em Settings → n8n API e acrescente:\n' +
      '  N8N_URL=https://n8n.chatyou.chat\n' +
      '  N8N_API_KEY=<a chave>\n',
    );
    process.exit(2);
  }

  const api = async (caminho) => {
    const r = await fetch(`${URL_BASE}/api/v1${caminho}`, {
      headers: { 'X-N8N-API-KEY': CHAVE, Accept: 'application/json' },
    });
    if (!r.ok) throw new Error(`GET ${caminho} -> HTTP ${r.status}`);
    return r.json();
  };

  const doRepo = new Map();
  for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.json'))) {
    const j = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
    doRepo.set(j.name || f.replace(/\.json$/, ''), { arquivo: f, wf: j });
  }

  const daInstancia = new Map();
  let pagina = await api('/workflows?limit=250');
  for (const w of pagina.data || []) daInstancia.set(w.name, w);
  while (pagina.nextCursor) {
    pagina = await api(`/workflows?limit=250&cursor=${encodeURIComponent(pagina.nextCursor)}`);
    for (const w of pagina.data || []) daInstancia.set(w.name, w);
  }

  const relatorio = { soNoRepo: [], soNaInstancia: [], divergentes: [], iguais: [] };

  for (const [nome, { arquivo, wf }] of doRepo) {
    const inst = daInstancia.get(nome);
    if (!inst) { relatorio.soNoRepo.push({ nome, arquivo }); continue; }
    const cheio = await api(`/workflows/${inst.id}`); // a lista não traz `nodes`
    const difs = compararWorkflow(wf, cheio);
    if (difs.length) relatorio.divergentes.push({ nome, arquivo, difs });
    else relatorio.iguais.push(nome);
  }
  for (const nome of daInstancia.keys()) {
    if (!doRepo.has(nome)) relatorio.soNaInstancia.push({ nome, id: daInstancia.get(nome).id });
  }

  if (soJson) {
    console.log(JSON.stringify(relatorio, null, 2));
  } else {
    console.log(`\n== Instância x repositório — ${doRepo.size} arquivo(s) no repo, ${daInstancia.size} workflow(s) na instância ==\n`);
    for (const { nome, arquivo, difs } of relatorio.divergentes) {
      console.log(`  ${nome}  (${arquivo}) — ${difs.length} divergência(s)`);
      for (const d of difs) {
        if (d.tipo) console.log(`     ${d.no}: ${d.tipo}`);
        else console.log(`     ${d.no} · ${d.campo}\n        repo:      ${d.repo}\n        instância: ${d.instancia}`);
      }
      console.log('');
    }
    if (relatorio.soNoRepo.length) console.log(`  só no repo: ${relatorio.soNoRepo.map((x) => x.nome).join(', ')}`);
    if (relatorio.soNaInstancia.length) console.log(`  só na instância: ${relatorio.soNaInstancia.map((x) => x.nome).join(', ')}`);
    if (relatorio.iguais.length) console.log(`  sem divergência: ${relatorio.iguais.join(', ')}`);
    console.log('');
  }

  const total = relatorio.divergentes.length + relatorio.soNoRepo.length + relatorio.soNaInstancia.length;
  process.exitCode = total > 0 ? 1 : 0;
}
