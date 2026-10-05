/**
 * O schema de TODA tool obedece ao `strict: true` que o serviço manda.
 *
 * 05/10/2026, CEEJAAR, conversa 85: quatro mensagens de um cliente real
 * ficaram sem resposta. O erro, no `erro` da `agente_fila`:
 *
 *   400 Invalid schema for function 'transferir_humano': In context=(),
 *   'required' is required to be supplied and to be an array including every
 *   key in properties. Missing 'time'.
 *
 * O `time` entrou em 21/09 com `required: ['resumo']`. A regra já estava
 * escrita no tipo (`FerramentaDoModelo.parametros`: "strict: todas as
 * propriedades em `required`; opcionais como `['tipo','null']`") e as outras
 * seis tools a seguiam. Nota não protege nem quem a escreve — este arquivo é
 * a regra deixando de ser nota.
 *
 * O que torna isso caro, e é a razão de a guarda existir: o schema vai no
 * MESMO request do turno, toda vez, mesmo que o modelo nunca chame a tool. Uma
 * tool com schema inválido não "fica muda": ela derruba o turno INTEIRO, de
 * TODO tenant. `transferir_humano` é básica — está na lista dos três perfis —,
 * então o raio foi todo mundo. Só CEEJAAR teve tráfego depois, e por isso só
 * ele aparece na fila.
 *
 * A lista de tools sai de `ferramentasDoPerfil`, não daqui: tool nova entra
 * sozinha. E a lista VAZIA reprova antes de qualquer comparação — uma guarda
 * que compara listas e aceita o vazio aprova o vazio que a produziu (é o
 * defeito que o conserto do portão trouxe de volta na hora, em 09/09).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { ferramentasDoPerfil } = await import(new URL('../agente/src/tools/index.ts', import.meta.url).href);

let ok = 0;
const falhas = [];
const chk = (nome, cond, extra = '') => {
  if (cond) { ok++; console.log(`  ok   ${nome}`); }
  else { falhas.push(nome); console.log(`  FALHA ${nome}${extra ? ' — ' + extra : ''}`); }
};

/**
 * Um contexto de brinquedo: as fábricas só montam o objeto (o `ctx` de verdade
 * é usado dentro de `executar`, que este teste não chama). `asaas` e
 * `aceitaLink` existem porque `gerar_link_pagamento` só entra na lista com eles
 * — sem isso a tool de pagamento não seria medida.
 */
const ctx = {
  db: null, tenant: { tenant_id: '00000000-0000-0000-0000-000000000000' }, conversationId: 1,
  chatwoot: {}, asaas: { chave: 'x' }, aceitaLink: true, agora: () => new Date(),
};

const PERFIS = [['basico', []], ['vendas', ['pagamento']]];
const tools = new Map();
for (const [perfil, ativas] of PERFIS) {
  for (const f of ferramentasDoPerfil(ctx, perfil, ativas)) tools.set(f.nome, f);
}

console.log(`\n== schemas colhidos de ferramentasDoPerfil: ${tools.size} ==`);

// 1. A lista não pode estar vazia, nem menor do que os dois perfis garantem.
//    Sem isto, qualquer quebra no import viraria "0 tools, 0 problemas".
chk('a varredura ACHOU tools (lista vazia reprova antes de comparar)', tools.size > 0, `vieram ${tools.size}`);
chk('achou as 3 básicas + as de vendas (>= 6)', tools.size >= 6, `vieram ${tools.size}: ${[...tools.keys()].join(',')}`);
chk('transferir_humano está entre elas (é básica: o raio de uma quebra é todo tenant)', tools.has('transferir_humano'));
chk('gerar_link_pagamento entrou (o ctx de teste precisa de asaas + aceitaLink)', tools.has('gerar_link_pagamento'));

// 2. A propriedade, por tool.
for (const [nome, f] of tools) {
  const p = f.parametros ?? {};
  const props = Object.keys(p.properties ?? {});
  const req = Array.isArray(p.required) ? p.required : null;

  chk(`${nome}: tem \`required\` como array`, req !== null, `veio ${JSON.stringify(p.required)}`);
  if (req === null) continue;

  const faltam = props.filter((k) => !req.includes(k));
  chk(`${nome}: TODA propriedade está em \`required\` (strict)`, faltam.length === 0, `faltam: ${faltam.join(', ')}`);

  const sobram = req.filter((k) => !props.includes(k));
  chk(`${nome}: \`required\` não cita o que não existe`, sobram.length === 0, `sobram: ${sobram.join(', ')}`);

  chk(`${nome}: additionalProperties === false`, p.additionalProperties === false, String(p.additionalProperties));

  // O opcional de verdade: quem é opcional continua opcional pelo TIPO,
  // `['x','null']`, nunca ficando de fora do `required`.
  for (const k of props) {
    const t = p.properties[k]?.type;
    const lista = Array.isArray(t);
    chk(`${nome}.${k}: tipo declarado`, typeof t === 'string' || lista, JSON.stringify(t));
    if (lista) chk(`${nome}.${k}: opcional é \`[tipo,'null']\``, t.includes('null'), JSON.stringify(t));
  }
}

// 3. A sabotagem: a guarda tem de REPROVAR o schema que estava em produção.
//    Sem isto ela poderia estar medindo nada — foi exatamente este schema que
//    passou por quinze dias de suíte verde.
console.log('\n== sabotagem: o schema de 21/09, verbatim ==');
const QUEBRADO = {
  type: 'object',
  properties: { resumo: { type: 'string' }, time: { type: 'string' } },
  required: ['resumo'],
  additionalProperties: false,
};
const faltamNoQuebrado = Object.keys(QUEBRADO.properties).filter((k) => !QUEBRADO.required.includes(k));
chk('S1: a regra ACUSA o schema que a OpenAI recusou (faltava `time`)', faltamNoQuebrado.length === 1 && faltamNoQuebrado[0] === 'time', JSON.stringify(faltamNoQuebrado));

const CORRIGIDO = {
  type: 'object',
  properties: { resumo: { type: 'string' }, time: { type: ['string', 'null'] } },
  required: ['resumo', 'time'],
  additionalProperties: false,
};
chk('S2: ...e APROVA o corrigido (a regra não reprova tudo)',
  Object.keys(CORRIGIDO.properties).every((k) => CORRIGIDO.required.includes(k)));

// 4. E o schema que sobe HOJE é o corrigido, não só "algum" corrigido.
const vivo = tools.get('transferir_humano')?.parametros;
chk('o `time` que sobe é `[string,null]` e está em `required`',
  Array.isArray(vivo?.properties?.time?.type) && vivo.properties.time.type.includes('null') && vivo.required.includes('time'),
  JSON.stringify(vivo?.properties?.time?.type) + ' required=' + JSON.stringify(vivo?.required));

console.log(`\n${falhas.length ? 'FALHOU' : 'passaram'}: ${ok} ok, ${falhas.length} falhas`);
if (falhas.length) { for (const f of falhas) console.log('  - ' + f); process.exit(1); }
