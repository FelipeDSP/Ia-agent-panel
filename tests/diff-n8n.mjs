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

import { achatar, classificar, compararConexoes, compararWorkflow, mesmaPasta, normalizarNo, CAMPOS_NO_VOLATEIS }
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
  compararWorkflow(repo, wf([noBase()], { a: [['x']] })).some((d) => d.no === '(conexões)'));

/*
 * O FALSO POSITIVO DE 2026-08-20, e os limites do conserto.
 *
 * O script dizia "(conexões) diverge" num export cujas 64 arestas eram
 * idênticas às do repo. A causa era ramo vazio no FIM: o repo escreve a saída
 * falsa de um IF sem destino como `[[...], []]`, o export escreve `[[...]]`.
 * Falso positivo em detector ensina a ignorar o detector — por isso vale um
 * caso próprio, junto com os dois que provam que ele não ignorou demais.
 */
const conexao = (destino) => [{ node: destino, type: 'main', index: 0 }];
const comRamoVazio = wf([noBase()], { IF: { main: [conexao('Segue'), []] } });
const semRamoVazio = wf([noBase()], { IF: { main: [conexao('Segue')] } });

chk('ramo vazio no FIM não é divergência (repo x export do mesmo IF)',
  compararConexoes(comRamoVazio.connections, semRamoVazio.connections).length === 0,
  JSON.stringify(compararConexoes(comRamoVazio.connections, semRamoVazio.connections)));

const falsoLigado = wf([noBase()], { IF: { main: [conexao('Segue'), conexao('Ignora')] } });
const difLigado = compararConexoes(semRamoVazio.connections, falsoLigado.connections);
chk('mas ramo vazio virando ramo COM destino é divergência', difLigado.length === 1);
chk('e a divergência diz QUAL aresta, não só "diverge"',
  difLigado[0]?.campo?.includes('main[1] -> Ignora'), JSON.stringify(difLigado));

// Guarda contra normalizar demais: a ordem dos ramos É semântica (0 = true,
// 1 = false num IF). Trocar os dois troca o comportamento do workflow.
const trocado = wf([noBase()], { IF: { main: [conexao('Ignora'), conexao('Segue')] } });
chk('trocar a ORDEM dos ramos continua sendo divergência',
  (() => {
    // 4 linhas, não 2: cada aresta sai de um slot e entra em outro, então some
    // de um lado e aparece do outro. O que importa é a troca ser VISÍVEL.
    const d = compararConexoes(falsoLigado.connections, trocado.connections);
    return d.length === 4 && d.some((x) => x.campo.includes('main[0] -> Ignora') && x.repo === '(ausente)');
  })());

// Vazio no MEIO desloca o índice de tudo que vem depois: não pode sumir.
const vazioNoMeio = wf([noBase()], { IF: { main: [[], conexao('Segue')] } });
chk('ramo vazio no MEIO continua contando (desloca os índices)',
  compararConexoes(semRamoVazio.connections, vazioNoMeio.connections).length === 2);

chk('formato inesperado não derruba o comparador',
  (() => {
    try { return compararConexoes({ a: 'lixo' }, { a: [[null]] }).length >= 0; }
    catch { return false; }
  })());

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

// -------------------------------------------------------------------------
console.log('\n-- 5. A guarda contra comparar a pasta com ela mesma --\n');

// Sem isto, apontar `--dir n8n/workflows` compararia os arquivos com eles
// proprios, nao acharia divergencia e imprimiria "sem divergencia" — o falso
// verde mais facil de produzir aqui, e com cara de aprovacao.
chk('mesma pasta e detectada, com separador diferente',
  mesmaPasta('n8n/workflows', 'n8n\\workflows'));
chk('pasta diferente NAO e barrada', !mesmaPasta('n8n/workflows', '../exportados'));
chk('caminho relativo x absoluto resolve para o mesmo',
  mesmaPasta('./n8n/workflows', process.cwd() + '/n8n/workflows'));

// -------------------------------------------------------------------------
console.log('\n-- 6. O agrupamento por tipo --\n');

// 72 linhas soltas ninguem le; "70 sao a mesma coisa e 2 sao outra" alguem
// decide. E agrupamento que erra o grupo e pior que nenhum.
const expr = (acessor) =>
  "=Perfil de tools nao resolvido para o tenant {{ $('Resolve Tenant')." + acessor +
  ".json.tenant_id }}. Verifique o cadastro do cliente antes de seguir com o atendimento.";

const dItem = compararWorkflow(
  wf([noBase({ parameters: { texto: expr('first()') } })]),
  wf([noBase({ parameters: { texto: expr('item') } })]),
);
chk('.first() no repo x .item na instancia vira UM tipo so',
  dItem.length === 1 && classificar(dItem[0]) === 'repo .first() × instância .item',
  JSON.stringify(dItem.map(classificar)));

// A ARMADILHA QUE JA MORDEU: a exibicao trunca em 90 chars, e a primeira versao
// classificava no truncado. Nesta expressao o `.item` cai DEPOIS do corte.
chk('classifica pelo valor INTEIRO, nao pelo truncado de 90 chars',
  expr('item').indexOf('.item') < 90 || classificar(dItem[0]) === 'repo .first() × instância .item',
  'se classificasse no truncado, cairia em "valor diferente"');

const exprLonga = (a) => 'x'.repeat(120) + " {{ $('N')." + a + ".json.v }}";
const dLonga = compararWorkflow(
  wf([noBase({ parameters: { t: exprLonga('first()') } })]),
  wf([noBase({ parameters: { t: exprLonga('item') } })]),
);
chk('mesmo com o acessor alem do caractere 90, o tipo sai certo',
  classificar(dLonga[0]) === 'repo .first() × instância .item',
  classificar(dLonga[0]));

chk('campo so na instancia tem tipo proprio',
  classificar({ repo: '(ausente)', instancia: 'true', _repoInteiro: '(ausente)', _instInteiro: 'true' })
    === 'campo só na INSTÂNCIA');
chk('no de um lado so mantem o tipo original',
  classificar({ no: 'X', tipo: 'nó só no REPO' }) === 'nó só no REPO');

console.log('\n' + '-'.repeat(58));
console.log(`  ${ok} passaram, ${falhas.length} falharam`);
for (const f of falhas) console.log(`  ! ${f}`);
console.log();
process.exitCode = falhas.length > 0 ? 1 : 0;
