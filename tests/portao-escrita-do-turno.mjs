/**
 * O portão só narra o pedido quando foi ESTE TURNO que o mexeu.
 *
 * O DEFEITO, medido no sendbox em 07/10/2026 (conversa 51):
 *
 *   12:18:48–12:18:54  quatro cliques no painel: separar, pago, separar, entregue
 *   12:20:53           o cliente escreveu só "oi"
 *   -> resposta: "Oi! Aqui é o Hércules 👋" + "📋 Seu pedido … Status: pago"
 *      com `bloco_anexado: true`, `escreveu_neste_turno: true`.
 *
 * `api_n8n_estado_pedido` infere "escreveu neste turno" por TEMPO: a linha do
 * pedido mudou depois da última saída, dentro de um teto de 5 min. A inferência
 * nasceu quando só o AGENTE escrevia em pedido. Desde a 69 o painel escreve, e
 * desde a 83 escreve muito mais — "Separar" e "Pagou e levou" são o trabalho de
 * quem prepara os pedidos. O portão não distingue a tool do agente de um clique
 * de uma pessoa dois minutos antes.
 *
 * Não é um caso de borda do sandbox: é o fluxo do Empório a partir de agora.
 * Alguém marca um pedido no balcão e o próximo cliente que escrever nos 5 min
 * seguintes recebe, colado na resposta, o resumo de um pedido que não é dele.
 *
 * O CONSERTO não mexe na janela — muda a pergunta. O serviço sabe quais tools
 * rodaram, porque é ele que as executa; a janela vira condição necessária e a
 * tool rodando é a outra.
 *
 * ESTREITAR É SEGURO: `escreveu_neste_turno` aparece em dois lugares do portão,
 * e em ambos `false` é a direção da defesa — a regra 1 barra MAIS, e o bloco
 * não gruda. Este teste prova as duas.
 *
 *   npm run teste:portao-escrita-do-turno
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { TOOLS_QUE_ESCREVEM_PEDIDO } = await import(new URL('../agente/src/turno/portao.ts', import.meta.url).href);
const { corpoRegra, rodarRegra } = await import(new URL('../agente/src/regras-js.ts', import.meta.url).href);
const REGRAS = path.join(RAIZ, 'agente', 'regras');

let ok = 0;
const falhas = [];
const chk = (nome, cond, det = '') => {
  if (cond) { ok++; console.log(`  ok    ${nome}`); }
  else { falhas.push(nome); console.log(`  FALHA ${nome}${det ? ' — ' + det : ''}`); }
};

/** Roda o portão de verdade, com o estado que a função devolveria. */
function portao(estado, textoModelo) {
  const saida = rodarRegra(corpoRegra(REGRAS, 'aplica-portao.js'), { json: estado }, {
    'Estima Tokens': { output: textoModelo, componentes_json: '{}' },
  });
  const comp = JSON.parse(String(saida.componentes_json ?? '{}'));
  return { texto: String(saida.output ?? ''), portao: comp.portao ?? saida._portao ?? {} };
}

const ESTADO_PAGO = {
  tem_pedido: true, pedido_id: 'p1', pedido_status: 'pago', pedido_numero: 7,
  total_centavos: 6990, itens: [{ nome: 'Curso de NR 20', quantidade: 1, preco_unit_centavos: 6990 }],
  escreveu_neste_turno: true, barrou_anterior: false, pagamento_confirmado: false,
};

console.log('\n== 1. O cenário exato de 07/10 ==\n');

// Com a janela dizendo "escreveu" (porque o PAINEL escreveu), o portão gruda.
const comJanela = portao({ ...ESTADO_PAGO }, 'Oi! Aqui é o Hércules, da estud.you 👋 Como posso te ajudar hoje?');
chk('REPRODUZ: com `escreveu_neste_turno` cru, a saudação ganha o bloco do pedido',
  /Seu pedido/.test(comJanela.texto) && comJanela.portao.bloco_anexado === true,
  comJanela.texto.slice(0, 80));

// Estreitado — que é o que o serviço passa a fazer quando nenhuma tool de
// pedido rodou no turno.
const estreitado = portao({ ...ESTADO_PAGO, escreveu_neste_turno: false }, 'Oi! Aqui é o Hércules, da estud.you 👋 Como posso te ajudar hoje?');
chk('CONSERTA: sem tool de pedido no turno, a saudação sai limpa',
  !/Seu pedido/.test(estreitado.texto) && estreitado.portao.bloco_anexado === false,
  estreitado.texto.slice(0, 80));
chk('...e a saudação continua inteira (não é censura, é não acrescentar)',
  estreitado.texto.trim() === 'Oi! Aqui é o Hércules, da estud.you 👋 Como posso te ajudar hoje?', estreitado.texto);

console.log('\n== 2. O turno que DE FATO mexeu continua narrando ==\n');
// Contraprova: sem ela, "o bloco não aparece" passaria com o portão quebrado.
const fechou = portao({ ...ESTADO_PAGO, escreveu_neste_turno: true }, 'Fechei seu pedido!');
chk('com a tool rodando, o bloco VAI (o conserto não desligou o recurso)',
  /Seu pedido/.test(fechou.texto) && fechou.portao.bloco_anexado === true);

console.log('\n== 3. Estreitar APERTA a defesa, nunca afrouxa ==\n');
// Regra 1: o modelo afirma efeito consumado e nada foi escrito -> barra.
const fabricou = portao({ ...ESTADO_PAGO, escreveu_neste_turno: false, pedido_status: 'rascunho' },
  'Pronto, já anotei o seu pedido aqui!');
chk('modelo afirma "já anotei" sem tool no turno -> o portão BARRA',
  fabricou.portao.veredito !== 'passou', JSON.stringify(fabricou.portao.veredito));
const naoFabricou = portao({ ...ESTADO_PAGO, escreveu_neste_turno: true, pedido_status: 'rascunho' },
  'Pronto, já anotei o seu pedido aqui!');
chk('...e com a tool no turno a MESMA frase passa (a regra não virou paranoia)',
  naoFabricou.portao.veredito === 'passou', JSON.stringify(naoFabricou.portao.veredito));

console.log('\n== 4. A lista de tools sai do CATÁLOGO, não da memória ==\n');
chk('a lista não está vazia (lista vazia estreitaria SEMPRE)',
  Array.isArray(TOOLS_QUE_ESCREVEM_PEDIDO) && TOOLS_QUE_ESCREVEM_PEDIDO.length > 0,
  JSON.stringify(TOOLS_QUE_ESCREVEM_PEDIDO));

const url = process.env.SUPABASE_DB_URL ?? fs.readFileSync(path.join(RAIZ, '.env.local'), 'utf8')
  .split(/\r?\n/).find((l) => l.startsWith('SUPABASE_DB_URL='))?.slice('SUPABASE_DB_URL='.length).trim().replace(/^["']|["']$/g, '');
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await c.connect();
try {
  const { rows } = await c.query(`
    select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and (p.prosrc ~* 'update[[:space:]]+public\\.pedidos'
         or p.prosrc ~* 'insert[[:space:]]+into[[:space:]]+public\\.pedidos')
     order by 1`);
  const escrevem = rows.map((r) => r.proname);
  chk('a varredura achou funções que escrevem em pedidos', escrevem.length > 0, String(escrevem.length));

  /**
   * As que NÃO acontecem dentro de um turno do agente. Declaradas com o motivo
   * — a lista é a premissa do conserto, e premissa não declarada é suposição.
   */
  const FORA_DO_TURNO = {
    api_n8n_pagamento_webhook: 'webhook do Asaas, fora de turno',
    painel_marcar_pedido: 'o painel — é exatamente a escrita que causou o defeito',
    expirar_pedidos_vencidos: 'manutenção periódica',
    pedidos_recalcula_total: 'trigger da própria tabela',
  };
  /** As de dentro do turno, todas alcançadas por `gerenciar_pedido`. */
  const DA_TOOL = [
    'api_n8n_adicionar_item', 'api_n8n_fechar_pedido', 'api_n8n_cancelar_pedido',
    'api_n8n_notificar_venda', 'api_n8n_confirmar_notificacao',
    'api_agente_aviso_pedido', 'api_agente_confirmar_aviso',
  ];
  const novas = escrevem.filter((f) => !(f in FORA_DO_TURNO) && !DA_TOOL.includes(f));
  chk('nenhum caminho NOVO escreve em pedidos sem estar declarado', novas.length === 0,
    novas.join(', ') + ' — se for de uma tool nova, ela entra em TOOLS_QUE_ESCREVEM_PEDIDO');

  // E as da tool de fato são alcançadas por ela (o par derivado do outro lado).
  const fonteTool = fs.readFileSync(path.join(RAIZ, 'agente', 'regras', 'tool-pedido-acoes.mjs'), 'utf8')
    + fs.readFileSync(path.join(RAIZ, 'agente', 'src', 'pedido', 'aviso.ts'), 'utf8');
  const orfas = DA_TOOL.filter((f) => !fonteTool.includes(f));
  chk('toda função declarada como "da tool" é mesmo chamada por ela', orfas.length === 0, orfas.join(', '));
} finally {
  await c.end();
}

console.log('\n== 5. A LIGAÇÃO no serviço (o outro lado do par) ==\n');
// Os blocos acima provam que o PORTAO se comporta certo recebendo
// `escreveu_neste_turno: false`. Isso nao prova que o SERVICO o manda assim —
// e foi exatamente o que a sabotagem mostrou: comentar a linha do
// estreitamento em `portao.ts` deixava a suite inteira VERDE. Asserção
// verdadeira sobre metade de um par derivado da sensacao de cobertura que a
// outra metade nao tem (CLAUDE.md, defeito nº 10).
//
// Aqui o sujeito e `aplicarPortao`, com um `db` de brinquedo que devolve o
// estado que a funcao do banco devolveria na conversa 51 das 12:20.
const { aplicarPortao } = await import(new URL('../agente/src/turno/portao.ts', import.meta.url).href);
const dbFalso = { query: async () => ({ rows: [{ ...ESTADO_PAGO }] }) };
const SAUDACAO = 'Oi! Aqui é o Hércules, da estud.you 👋 Como posso te ajudar hoje?';
const chamar = (toolsDoTurno) => aplicarPortao({
  db: dbFalso, regrasDir: REGRAS, tenantId: 't', conversationId: 51, perfil: 'vendas',
  textoModelo: SAUDACAO, componentes: {}, toolsDoTurno,
});

const semTool = await chamar([]);
chk('serviço: turno SEM tool de pedido -> o bloco nao gruda',
  !/Seu pedido/.test(semTool.output), semTool.output.slice(0, 70));
chk('serviço: ...e o trace registra POR QUE (senao ninguem explica depois)',
  semTool.portao.escrita_do_painel_ignorada === true, JSON.stringify(semTool.portao.escrita_do_painel_ignorada));

const soBusca = await chamar(['busca_conhecimento']);
chk('serviço: tool que NAO e de pedido tambem nao conta', !/Seu pedido/.test(soBusca.output));

const comTool = await chamar(['gerenciar_pedido']);
chk('serviço: com `gerenciar_pedido` no turno, o bloco VAI',
  /Seu pedido/.test(comTool.output), comTool.output.slice(0, 70));
chk('serviço: e aí nao ha o que registrar como ignorado',
  comTool.portao.escrita_do_painel_ignorada === undefined);

// E se a janela ja disser que nada mudou, a tool rodando nao inventa nada.
const dbParado = { query: async () => ({ rows: [{ ...ESTADO_PAGO, escreveu_neste_turno: false }] }) };
const janelaFria = await aplicarPortao({
  db: dbParado, regrasDir: REGRAS, tenantId: 't', conversationId: 51, perfil: 'vendas',
  textoModelo: SAUDACAO, componentes: {}, toolsDoTurno: ['gerenciar_pedido'],
});
chk('serviço: a janela continua sendo condicao NECESSARIA (a tool nao a substitui)',
  !/Seu pedido/.test(janelaFria.output) && janelaFria.portao.escrita_do_painel_ignorada === undefined);


console.log('\n== 5. Sabotagem ==\n');
chk('S1: a lista VAZIA estreitaria todo turno e mataria o bloco — por isso o bloco 4 a reprova',
  [].some((t) => TOOLS_QUE_ESCREVEM_PEDIDO.includes(t)) === false);
const PORTAO_FONTE = fs.readFileSync(path.join(REGRAS, 'aplica-portao.js'), 'utf8');
chk('S2: o portão continua lendo `escreveu_neste_turno` nos DOIS lugares',
  (PORTAO_FONTE.match(/escreveuNesteTurno/g) ?? []).length >= 3);

console.log(`\n${falhas.length ? 'FALHOU' : 'passaram'}: ${ok} ok, ${falhas.length} falhas`);
if (falhas.length) { for (const f of falhas) console.log('  - ' + f); process.exit(1); }
