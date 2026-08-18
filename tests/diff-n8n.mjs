#!/usr/bin/env node
/**
 * A COMPARAÇÃO INSTÂNCIA×REPO ENXERGA O QUE PRECISA E IGNORA O QUE DEVE?
 *
 * O diff só vale se as duas metades estiverem certas: se ele ignorar de menos,
 * o relatório afoga em ruído e ninguém lê; se ignorar de mais, esconde a deriva
 * que ele existe para achar.
 *
 * O caso concreto que originou tudo: `responsesApiEnabled: true` existe na
 * instância e não no arquivo. Nenhum teste do projeto pegava isso — foi
 * descoberto porque alguém reparou num print.
 *
 * NÃO toca na instância e não precisa de chave de API: exercita as funções
 * puras de `scripts/diff-n8n-instancia.mjs` contra workflows sintéticos. É o
 * que permitiu escrever e provar o script antes de existir credencial.
 *
 * Uso: npm run teste:diff-n8n
 */

import { achatar, compararWorkflow, normalizarNo, CAMPOS_NO_VOLATEIS }
  from '../scripts/diff-n8n-instancia.mjs';

let ok = 0;
const falhas = [];
const chk = (n, c, d = '') => {
  if (c) { ok++; console.log(`  OK    ${n}`); }
  else { falhas.push(`${n}${d ? ' — ' + d : ''}`); console.log(`  FALHA ${n}${d ? ' — ' + d : ''}`); }
};

const noBase = (extra = {}) => ({
  name: 'OpenAI Chat Model',
  type: '@n8n/n8n-nodes-langchain.lmChatOpenAi',
  typeVersion: 1.3,
  position: [100, 200],
  id: 'c7e79157-fca8-4a0e-a6b4-7ef492836b16',
  credentials: { openAiApi: { id: 'B4TZHIczm0tpk2wS', name: 'OpenAi Chatyou' } },
  parameters: { model: { __rl: true, mode: 'id', value: '={{ x }}' }, builtInTools: {}, options: { temperature: 0.3 } },
  ...extra,
});

const wf = (nos, conexoes = { a: [] }) => ({ name: 'X', nodes: nos, connections: conexoes });

console.log('\n== Diff instância × repositório ==\n');

// -------------------------------------------------------------------------
console.log('-- 1. O caso real: campo só na instância --\n');

const repo = wf([noBase()]);
const inst = wf([noBase({ parameters: { ...noBase().parameters, responsesApiEnabled: true, notice: '' } })]);
const d1 = compararWorkflow(repo, inst);
const achouResponses = d1.some((d) => d.campo === 'parameters.responsesApiEnabled' && d.repo === '(ausente)');
chk('acha `responsesApiEnabled` presente só na instância', achouResponses, JSON.stringify(d1));
chk('e diz que no repo está ausente',
  d1.some((d) => d.campo === 'parameters.responsesApiEnabled' && String(d.instancia) === 'true'));

// -------------------------------------------------------------------------
console.log('\n-- 2. O volátil é mesmo ignorado --\n');

const moveu = wf([noBase({ position: [999, 888], id: 'outro-uuid-qualquer' })]);
chk('mover o nó no canvas NÃO vira divergência', compararWorkflow(repo, moveu).length === 0,
  JSON.stringify(compararWorkflow(repo, moveu)));

const credOutroId = wf([noBase({ credentials: { openAiApi: { id: 'ID-DIFERENTE', name: 'OpenAi Chatyou' } } })]);
chk('credencial com id diferente e MESMO nome não vira divergência',
  compararWorkflow(repo, credOutroId).length === 0);

const credOutroNome = wf([noBase({ credentials: { openAiApi: { id: 'x', name: 'Outra Conta' } } })]);
chk('credencial com NOME diferente VIRA divergência (é troca de conta)',
  compararWorkflow(repo, credOutroNome).some((d) => d.campo.includes('credentials')));

// -------------------------------------------------------------------------
console.log('\n-- 3. O que não pode escapar --\n');

const semNo = wf([]);
chk('nó que sumiu da instância aparece', compararWorkflow(repo, semNo).some((d) => d.tipo === 'nó só no REPO'));
chk('nó extra na instância aparece',
  compararWorkflow(semNo, repo).some((d) => d.tipo === 'nó só na INSTÂNCIA'));

const outraVersao = wf([noBase({ typeVersion: 1.2 })]);
chk('typeVersion diferente aparece', compararWorkflow(repo, outraVersao).some((d) => d.campo === 'typeVersion'));

const outraTemp = wf([noBase({ parameters: { ...noBase().parameters, options: { temperature: 0.9 } } })]);
chk('parâmetro aninhado diferente aparece',
  compararWorkflow(repo, outraTemp).some((d) => d.campo === 'parameters.options.temperature'));

chk('conexões diferentes aparecem',
  compararWorkflow(repo, wf([noBase()], { a: [['x']] })).some((d) => d.campo === 'connections'));

// Objeto vazio x chave ausente: `builtInTools: {}` no repo e ausente na
// instância É divergência, e tem de aparecer — foi assim que `notice: ""`
// entrou sem ninguém ver.
const semBuiltIn = wf([noBase({ parameters: { model: noBase().parameters.model, options: { temperature: 0.3 } } })]);
chk('objeto vazio no repo x ausente na instância aparece',
  compararWorkflow(repo, semBuiltIn).some((d) => d.campo === 'parameters.builtInTools'));

// -------------------------------------------------------------------------
console.log('\n-- 4. Sabotagem --\n');

chk('sabotagem: `position` fora da lista de volátil faria mover virar divergência',
  (() => {
    CAMPOS_NO_VOLATEIS.delete('position');
    const pegou = compararWorkflow(repo, moveu).some((d) => d.campo === 'position.0');
    CAMPOS_NO_VOLATEIS.add('position');           // restaura
    return pegou;
  })(),
  'sem isso, a regra de volátil seria decorativa');

chk('e a restauração funcionou (mover volta a ser ignorado)',
  compararWorkflow(repo, moveu).length === 0);

chk('achatar não perde chave aninhada',
  Object.keys(achatar({ a: { b: { c: 1 } } })).includes('a.b.c'));
chk('normalizarNo tira o volátil de topo',
  !Object.keys(normalizarNo(noBase())).some((k) => k.startsWith('position')));

console.log('\n' + '-'.repeat(58));
console.log(`  ${ok} passaram, ${falhas.length} falharam`);
for (const f of falhas) console.log(`  ! ${f}`);
console.log();
process.exitCode = falhas.length > 0 ? 1 : 0;
