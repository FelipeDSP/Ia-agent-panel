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
 * DE ONDE VEM O LADO "INSTÂNCIA" — duas fontes, e a primeira é a recomendada.
 *
 * 1. ARQUIVOS EXPORTADOS pela UI (padrão, e o caminho preferido):
 *
 *      node scripts/diff-n8n-instancia.mjs --dir ../exportados-18-08
 *
 *    Manual, uma vez por mês, e não faz segredo nenhum circular. A UI exporta
 *    UM workflow por vez, então exportar só o que interessa é o uso normal: o
 *    que não estiver na pasta sai como **NÃO VERIFICADO**, e não como ausente.
 *
 *      ... --dir <pasta> --completo
 *
 *    afirma que a pasta tem os nove. Aí o que faltar volta a ser achado.
 *
 * 2. API pública do n8n (`N8N_URL` + `N8N_API_KEY` no `.env.local`):
 *
 *    ATENÇÃO AO QUE ESSA CHAVE VALE. Quem a tem cria workflow, e workflow lê
 *    TODAS as credenciais da instância: Postgres, Redis, OpenAI e os tokens de
 *    Chatwoot de todos os clientes. É acesso MAIOR que o do Supabase. Ela não
 *    deve ser colada em conversa nem trafegar por chat.
 *
 *    Se um dia valer automatizar, o caminho é a chave MORAR NO SERVIDOR — um
 *    workflow agendado do próprio n8n, ou job no Coolify com env var. Nunca
 *    passando por uma pessoa.
 *
 * (A sessão do navegador não é opção: expira — a desta instância expirou no
 * meio da investigação que originou este script —, exige humano logado e não
 * roda sozinha.)
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
      // Guarda o valor INTEIRO para classificar e o truncado para exibir. A
      // primeira versao classificava no truncado: expressao longa tinha o
      // `.item` cortado fora dos 90 chars e caia em "valor diferente" — 5 das
      // 67 na primeira rodada. Agrupamento que erra o grupo e pior que nenhum,
      // porque muda a decisao de quem le o resumo.
      difs.push({
        no: nomeNo,
        campo: chave,
        repo: pa[chave] === undefined ? '(ausente)' : String(pa[chave]).slice(0, 90),
        instancia: pb[chave] === undefined ? '(ausente)' : String(pb[chave]).slice(0, 90),
        _repoInteiro: pa[chave] === undefined ? '(ausente)' : String(pa[chave]),
        _instInteiro: pb[chave] === undefined ? '(ausente)' : String(pb[chave]),
      });
    }
  }

  if (JSON.stringify(wfRepo.connections) !== JSON.stringify(wfInstancia.connections)) {
    difs.push({ no: '(conexões)', campo: 'connections', repo: 'ver arquivo', instancia: 'diverge' });
  }
  return difs;
}

/**
 * Classifica a divergência num TIPO, para o relatório sair agrupado.
 *
 * Setenta e duas linhas soltas ninguém lê; setenta e duas linhas com "70 são a
 * mesma coisa e 2 são outra" alguém decide. Foi o que aconteceu na primeira
 * rodada real: a esmagadora maioria era a troca `.item` -> `.first()` que o
 * repositório fez em 12/08 e a instância nunca recebeu, e o que importava era
 * justamente o punhado que NÃO era isso.
 */
export function classificar(d) {
  if (d.tipo) return d.tipo;                       // nó só de um lado
  const r = String(d._repoInteiro ?? d.repo ?? '');
  const i = String(d._instInteiro ?? d.instancia ?? '');
  const temFirst = /\)\.first\(\)/.test(r);
  const temItem = /\)\.item\b/.test(i);
  if (temFirst && temItem) return 'repo .first() × instância .item';
  if (r === '(ausente)') return 'campo só na INSTÂNCIA';
  if (i === '(ausente)') return 'campo só no REPO';
  return 'valor diferente';
}

/**
 * A pasta de exportados é a MESMA do repositório?
 *
 * Guarda contra o falso verde mais fácil de produzir aqui: apontar `--dir` para
 * `n8n/workflows` compara os arquivos com eles próprios, não acha divergência
 * nenhuma e imprime "sem divergência" — tautologia com cara de aprovação.
 */
export function mesmaPasta(a, b) {
  return path.resolve(a) === path.resolve(b);
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
  const iDir = process.argv.indexOf('--dir');
  const completo = process.argv.includes('--completo');
  const soResumo = process.argv.includes('--resumo');
  const DIR_EXPORT = iDir >= 0 ? process.argv[iDir + 1] : null;
  const URL_BASE = (process.env.N8N_URL || '').replace(/\/+$/, '');
  const CHAVE = process.env.N8N_API_KEY;

  if (DIR_EXPORT && !fs.existsSync(DIR_EXPORT)) {
    console.error(`\nPasta nao encontrada: ${DIR_EXPORT}\n`);
    process.exit(2);
  }
  if (DIR_EXPORT && mesmaPasta(DIR_EXPORT, DIR)) {
    console.error(
      `\n--dir aponta para o PROPRIO diretorio do repositorio (${DIR}).\n` +
      'Isso compararia os arquivos com eles mesmos e diria "sem divergencia"\n' +
      'sem ter verificado nada. Exporte da UI para outra pasta.\n',
    );
    process.exit(2);
  }

  if (!DIR_EXPORT && (!URL_BASE || !CHAVE)) {
    console.error(
      '\nInforme a fonte do lado "instancia". Duas opcoes:\n\n' +
      '  1. arquivos exportados pela UI (recomendado):\n' +
      '       node scripts/diff-n8n-instancia.mjs --dir <pasta>\n\n' +
      '  2. API publica (N8N_URL + N8N_API_KEY no .env.local) — lembrando que\n' +
      '     essa chave le TODAS as credenciais da instancia, tokens de Chatwoot\n' +
      '     de todos os clientes inclusive.\n',
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
  if (DIR_EXPORT) {
    for (const f of fs.readdirSync(DIR_EXPORT).filter((x) => x.endsWith('.json'))) {
      const j = JSON.parse(fs.readFileSync(path.join(DIR_EXPORT, f), 'utf8'));
      // Copiar UM NO no n8n tambem gera .json. Sem `nodes` nao e workflow, e
      // avisar e melhor que ignorar calado: arquivo errado na pasta viraria
      // "workflow sumiu da instancia", que e o diagnostico oposto.
      if (!Array.isArray(j.nodes)) {
        console.error(`  aviso: ${f} nao parece workflow exportado (sem "nodes") — ignorado`);
        continue;
      }
      daInstancia.set(j.name || f.replace(/\.json$/, ''), j);
    }
  } else {
    let pagina = await api('/workflows?limit=250');
    for (const w of pagina.data || []) daInstancia.set(w.name, w);
    while (pagina.nextCursor) {
      pagina = await api(`/workflows?limit=250&cursor=${encodeURIComponent(pagina.nextCursor)}`);
      for (const w of pagina.data || []) daInstancia.set(w.name, w);
    }
  }

  const relatorio = { soNoRepo: [], naoVerificados: [], soNaInstancia: [], divergentes: [], iguais: [] };

  for (const [nome, { arquivo, wf }] of doRepo) {
    const inst = daInstancia.get(nome);
    if (!inst) {
      /*
       * AUSENTE NA FONTE NAO SIGNIFICA AUSENTE NA INSTANCIA.
       *
       * A UI do n8n exporta um workflow por vez, entao pasta com 1 de 9 e uso
       * normal. Reportar os outros 8 como "so no repo" afirma que sumiram da
       * instancia — o diagnostico OPOSTO do real, e alarme falso ensina a
       * ignorar o relatorio.
       *
       * Quem sabe o conjunto inteiro e a API (lista tudo) ou uma afirmacao
       * explicita de quem exportou (`--completo`). Sem uma das duas, o honesto
       * e dizer NAO VERIFICADO.
       */
      if (DIR_EXPORT && !completo) relatorio.naoVerificados.push({ nome, arquivo });
      else relatorio.soNoRepo.push({ nome, arquivo });
      continue;
    }
    // Pela API a lista nao traz `nodes`; do arquivo exportado ja veio tudo.
    const cheio = DIR_EXPORT ? inst : await api(`/workflows/${inst.id}`);
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
    console.log(`\n== Instancia x repositorio — ${doRepo.size} no repo, ${daInstancia.size} da instancia ` +
      `(fonte: ${DIR_EXPORT ? 'exportados de ' + DIR_EXPORT : 'API'}) ==\n`);
    // RESUMO POR TIPO primeiro. O detalhe continua abaixo, mas quem abre o
    // relatorio precisa saber em 3 linhas se sao 70 de uma coisa ou 70 coisas.
    const porTipo = new Map();
    for (const { difs } of relatorio.divergentes) {
      for (const d of difs) {
        const t = classificar(d);
        if (!porTipo.has(t)) porTipo.set(t, []);
        porTipo.get(t).push(d);
      }
    }
    if (porTipo.size) {
      const totalDifs = [...porTipo.values()].reduce((a, v) => a + v.length, 0);
      console.log(`  RESUMO — ${totalDifs} divergência(s) em ${relatorio.divergentes.length} workflow(s):\n`);
      for (const [t, v] of [...porTipo.entries()].sort((a, b) => b[1].length - a[1].length)) {
        console.log(`     ${String(v.length).padStart(4)}  ${t}`);
      }
      console.log('');
    }

    for (const { nome, arquivo, difs } of (soResumo ? [] : relatorio.divergentes)) {
      console.log(`  ${nome}  (${arquivo}) — ${difs.length} divergência(s)`);
      for (const d of difs) {
        if (d.tipo) console.log(`     ${d.no}: ${d.tipo}`);
        else console.log(`     [${classificar(d)}] ${d.no} · ${d.campo}\n        repo:      ${d.repo}\n        instância: ${d.instancia}`);
      }
      console.log('');
    }
    const verificados = relatorio.divergentes.length + relatorio.iguais.length;
    console.log(`  verificados: ${verificados} de ${doRepo.size}`);
    if (relatorio.naoVerificados.length) {
      console.log(`\n  NAO VERIFICADOS (${relatorio.naoVerificados.length}) — ausentes da pasta exportada.`);
      console.log('  Isto NAO quer dizer que sumiram da instancia; quer dizer que nao foram');
      console.log('  conferidos. Exporte-os tambem, ou rode com --completo se a pasta ja tem todos.');
      for (const x of relatorio.naoVerificados) console.log(`     ${x.nome}  (${x.arquivo})`);
    }
    if (relatorio.soNoRepo.length) console.log(`\n  SO NO REPO — ausentes da instancia: ${relatorio.soNoRepo.map((x) => x.nome).join(', ')}`);
    if (relatorio.soNaInstancia.length) console.log(`  só na instância: ${relatorio.soNaInstancia.map((x) => x.nome).join(', ')}`);
    if (relatorio.iguais.length) console.log(`  sem divergência: ${relatorio.iguais.join(', ')}`);
    console.log('');
  }

  // `naoVerificados` NAO entra: nao e achado, e ausencia de verificacao — e
  // reprovar por isso faria o uso normal (exportar um por vez) sair vermelho.
  const total = relatorio.divergentes.length + relatorio.soNoRepo.length + relatorio.soNaInstancia.length;
  process.exitCode = total > 0 ? 1 : 0;
}
