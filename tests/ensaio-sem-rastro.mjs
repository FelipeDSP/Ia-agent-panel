/**
 * O ENSAIO (`POST /testar`, 14/10) — roda o turno de verdade e não deixa rastro.
 *
 * POR QUE ELE EXISTE. Para testar a Acqua em 10/10 foi preciso achar a conversa
 * no Chatwoot, cortar a memória por função de banco, descobrir que ela estava
 * PAUSADA por mensagem humana, retomar, mandar pela API e esperar a ida e volta
 * do WhatsApp — isso por mudança de prompt. O ensaio responde "o que o agente
 * DIRIA" com o prompt real, a base real, o catálogo real e o portão real, sem
 * nada disso.
 *
 * ================== A ASSERÇÃO PRINCIPAL É DERIVADA ==================
 *
 * "Não deixa rastro" não é conferido contra uma lista de tabelas que eu lembrei
 * de olhar. A lista sai do CATÁLOGO do Postgres: toda tabela de `public` com
 * coluna `tenant_id` (26 em 14/10), e o que pode mudar é uma lista de TRÊS,
 * declarada abaixo com o motivo. Escrita nova em qualquer outra reprova.
 *
 * Isso não é zelo. A primeira versão do ensaio criava uma linha em `conversas`
 * (id -1) que apareceria na tela de Conversas do cliente, e eu tinha montado os
 * desvios LENDO o código: a conversa entrava por `api_n8n_conversa_sync`, que
 * não parece escrita quando se lê o nome. O retrato pegou (`conversas: 74 ->
 * 75`). Depois, com o retrato das 26, apareceu `agente_prompts` — que eu também
 * não tinha previsto, e que está CERTO (está na lista dos três, com o porquê).
 * Duas vezes a lista de efeitos colaterais feita de memória estava incompleta,
 * nas duas o retrato achou. Lista de efeito colateral não se faz de memória.
 *
 * E tem CONTRAPROVA: o mesmo turno sem ensaio escreve em `mensagens_log` e
 * `conversas`. Sem ela, "não escreveu" seria verdade também num turno que nem
 * rodou — a asserção vácua que este repositório já pegou seis vezes.
 *
 * O MODELO É DUBLÊ. O que se mede é o ensaio, não a OpenAI, e teste que gasta
 * token por execução é teste que se deixa de rodar. O dublê guarda o que
 * recebeu — é por ali que as asserções de ferramenta e de memória olham.
 *
 * Tenant efêmero, criado e removido pelo próprio teste; nenhum slug de seed.
 *
 *   npm run teste:ensaio
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import { diferencas, retratoDoTenant, tabelasDoTenant } from './lib/retrato-tenant.mjs';

import { executarTurno } from '../agente/src/turno/executar.ts';
import { chatwootMudo, CONVERSA_DE_ENSAIO } from '../agente/src/turno/ensaio.ts';
import { TOOLS_SO_LEITURA } from '../agente/src/tools/index.ts';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * As ÚNICAS tabelas que o ensaio pode tocar, e por quê:
 *
 *  - `agente_turnos` / `agente_passos`: o trace. É a RAZÃO de o ensaio existir
 *    — ver o prompt que foi montado, a busca que rodou e o veredito do portão é
 *    o que transforma "a resposta ficou ruim" em "a base não tem esse chunk".
 *    Fica marcado com `acao = 'ensaio'`, então é separável do que é real.
 *  - `agente_prompts`: o prompt do trace, endereçado por hash
 *    (`api_agente_prompt_registrar`). Sem ele o trace guarda um hash que não
 *    resolve. Não é o histórico de prompt do cliente — esse é `prompt_versoes`,
 *    e a asserção abaixo exige que ele fique intacto.
 *
 * Qualquer outra tabela que crescer num ensaio é defeito, inclusive uma que
 * ainda não existe hoje.
 */
const TABELAS_DE_TRACE = ['agente_turnos', 'agente_passos', 'agente_prompts'];

let ok = 0;
const falhas = [];
const chk = (nome, cond, det = '') => {
  if (cond) { ok++; console.log(`  ok    ${nome}`); }
  else { falhas.push(nome); console.log(`  FALHA ${nome}${det ? ' - ' + det : ''}`); }
};

const linhaEnv = (chave) => fs.readFileSync(path.join(RAIZ, '.env.local'), 'utf8')
  .split(/\r?\n/).find((l) => l.startsWith(chave + '='))?.slice(chave.length + 1).trim().replace(/^["']|["']$/g, '');
const url = process.env.SUPABASE_DB_URL ?? linhaEnv('SUPABASE_DB_URL');
const pool = new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 3 });
const q = async (s, p = []) => (await pool.query(s, p)).rows;

const SLUG = 'zz-ensaio-' + crypto.randomUUID().slice(0, 8);
const CONVERSA_REAL = 777001;
let tenantId = null;

/** O que o dublê viu no último turno — a janela para dentro do turno. */
let visto = {};
const modeloDuble = {
  async responder(p) {
    visto = {
      ferramentas: p.ferramentas.map((f) => f.nome),
      historico: p.historico,
      systemMessage: p.systemMessage,
    };
    const uso = { entrada: 10, saida: 5 };
    await p.aoChamarModelo?.({ iteracao: 1, texto: 'resposta do duble', toolCalls: 0, uso, latenciaMs: 1 });
    return {
      texto: 'resposta do duble', uso, tools: [], estourouTeto: false,
      chamadas: [{ iteracao: 1, uso, toolCalls: 0, latenciaMs: 1, texto: 'resposta do duble' }],
    };
  },
};

const deps = {
  db: pool, waha: null, modelo: modeloDuble, embeddings: null, transcritor: null,
  regrasDir: path.join(RAIZ, 'agente', 'regras'), versaoCodigo: 'teste', fotoSecret: null,
  fetchFn: fetch,
  // `asaas` só precisa EXISTIR: é a condição para `gerar_link_pagamento` entrar
  // na lista do modelo (que é o que este teste quer ver sendo filtrada). A tool
  // não é chamada — o dublê não chama tool nenhuma.
  asaas: {},
};
const msg = (texto) => [{
  acao: 'processar', mensagem: texto, anexo: null, contact_name: 'Fulano',
  phone: '5569999990000', chatwoot_account_id: 1, chatwoot_inbox_id: 1, message_id: null,
}];

/**
 * CHECKSUM, NÃO CONTAGEM — e `tenants` incluída.
 *
 * A primeira versão deste retrato contava linhas das tabelas com `tenant_id`.
 * Duas cegueiras, as duas achadas pela sabotagem do teste irmão do assistente:
 * contagem não vê UPDATE, e `tenants` não tem `tenant_id` (a chave é `id`),
 * então a tabela do prompt e do horário ficava fora de um retrato que eu
 * considerava completo. Ver `tests/lib/retrato-tenant.mjs`.
 */
let TABELAS = [];
const retrato = () => retratoDoTenant(q, tenantId, TABELAS);
const cresceram = (a, b) => diferencas(a, b);

try {
  // ---- a lista de tabelas sai do catálogo, não da minha memória -------------
  TABELAS = await tabelasDoTenant(q);
  const NOMES = TABELAS.map((t) => t.tabela);

  console.log('\n=== 0. A varredura alcança o que precisa ===\n');
  // Guarda que reprova a lista VAZIA antes de comparar: uma varredura que não
  // acha nada aprova qualquer coisa, e foi assim que a extração de colunas do
  // portão nasceu aprovando um SELECT sem coluna (09/09).
  chk(`a varredura achou tabelas (${NOMES.length})`, NOMES.length >= 20, String(NOMES.length));
  chk('...e inclui `tenants`, pela coluna `id` (a que a contagem deixava de fora)',
    TABELAS.some((t) => t.tabela === 'tenants' && t.coluna === 'id'));
  for (const t of ['mensagens_log', 'conversas', 'agente_fila', 'pedidos', 'prompt_versoes'])
    chk(`...e inclui \`${t}\``, NOMES.includes(t));
  for (const t of TABELAS_DE_TRACE)
    chk(`a tabela de trace \`${t}\` existe (senão a licença é para um nome morto)`, NOMES.includes(t));

  const [t] = await q(`insert into public.tenants (nome, slug, system_prompt, modelo)
      values ($1, $1, 'Você é um atendente da loja de teste.', 'gpt-4.1-mini') returning id`, [SLUG]);
  tenantId = t.id;
  // Vendas com tudo contratado: é o que faz a lista de ferramentas do modelo
  // ter o que filtrar. Sem isto o perfil é `basico` e a asserção do filtro
  // ficaria quase vácua — provaria que 2 de 3 passaram, sem nunca ver
  // `gerenciar_pedido`, que é a que escreve pedido de cliente.
  for (const tool of ['vendas', 'transferir_humano', 'foto_produto', 'pagamento'])
    await q(`insert into public.tenant_tools (tenant_id, tool_nome, ativo, contratado)
        values ($1, $2, true, true) on conflict do nothing`, [tenantId, tool]);

  const tenant = (await q(`select id as tenant_id, slug, nome, agente_ativo, system_prompt, modelo, temperatura,
        debounce_segundos, msg_midia_nao_suportada, msg_fora_escopo, chatwoot_url
      from public.tenants where id = $1`, [tenantId]))[0];

  // =========================================================================
  console.log('\n=== 1. O ensaio NÃO escreve (toda tabela do tenant, por checksum) ===\n');

  const antes = await retrato();
  const envios = [];
  const r = await executarTurno({ ...deps, chatwoot: chatwootMudo(envios) }, {
    tenant, conversationId: CONVERSA_DE_ENSAIO, filaIds: [], mensagens: msg('oi'), ensaio: { historico: [] },
  });
  const depois = await retrato();
  const mudou = cresceram(antes, depois);

  chk('o turno de ensaio rodou e respondeu', r.status === 'ok' && (r.resposta ?? '').includes('duble'),
    JSON.stringify({ status: r.status, motivo: r.motivo }));
  const indevidas = mudou.filter((x) => !TABELAS_DE_TRACE.includes(x));
  chk('nenhuma tabela fora do trace mudou', indevidas.length === 0,
    indevidas.join(', '));
  // Nomeadas uma a uma porque são as que o cliente VÊ na tela:
  for (const t of ['mensagens_log', 'conversas', 'agente_fila', 'prompt_versoes', 'pedidos'])
    chk(`\`${t}\` intacta (conteúdo, não contagem)`, antes[t] === depois[t], `${antes[t]} -> ${depois[t]}`);
  // CONTRAPROVA de que o retrato mede algo: o trace TEM de ter crescido.
  chk('o trace MUDOU (senão o retrato estaria cego)',
    TABELAS_DE_TRACE.every((x) => depois[x] !== antes[x]),
    TABELAS_DE_TRACE.filter((x) => depois[x] === antes[x]).join(', '));

  console.log('\n--- e o cliente não é cobrado pelo ensaio ---\n');
  // Decisão do Felipe quando o assistente foi aprovado: "o custo vai ser
  // nosso, a agência lida com o dele". Isso é uma consequência de onde o
  // consumo é contado, não uma intenção — então a asserção vai buscar as
  // FONTES no corpo de `billing_consumo_mensal` em vez de confiar que são
  // `mensagens_log` e `uso_ingestao` para sempre.
  const corpoBilling = (await q(`select prosrc from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'billing_consumo_mensal'`))[0]?.prosrc ?? '';
  const fontesDoBilling = NOMES.filter((t) => corpoBilling.includes(`public.${t}`));
  chk('as fontes do consumo saíram do corpo da função (lista vazia não aprova)',
    fontesDoBilling.length > 0, JSON.stringify(fontesDoBilling));
  const cobradas = fontesDoBilling.filter((t) => antes[t] !== depois[t]);
  chk(`o ensaio não escreveu em nenhuma fonte de cobrança (${fontesDoBilling.join(', ')})`,
    cobradas.length === 0, JSON.stringify(cobradas));

  console.log('\n--- e o Chatwoot ficou mudo ---\n');
  chk('nada foi enviado: o mudo ANOTOU em vez de falar', envios.length > 0, JSON.stringify(envios));
  chk('...e o que ele TERIA enviado fica legível', envios.some((e) => e.conteudo.includes('duble')), JSON.stringify(envios));

  // =========================================================================
  console.log('\n=== 2. CONTRAPROVA: o mesmo turno SEM ensaio escreve ===\n');

  const antesN = await retrato();
  await executarTurno({ ...deps, chatwoot: chatwootMudo([]) }, {
    tenant, conversationId: CONVERSA_REAL, filaIds: [], mensagens: msg('oi de verdade'),
  });
  const depoisN = await retrato();
  const ferramentasSemEnsaio = visto.ferramentas;

  chk('turno NORMAL escreve em `mensagens_log`', depoisN.mensagens_log > antesN.mensagens_log,
    `${antesN.mensagens_log} -> ${depoisN.mensagens_log}`);
  chk('turno NORMAL cria a conversa', depoisN.conversas > antesN.conversas, `${antesN.conversas} -> ${depoisN.conversas}`);

  // =========================================================================
  console.log('\n=== 3. Só as ferramentas de leitura chegam ao modelo ===\n');

  // A lista completa não está escrita aqui: é a que o turno NORMAL acabou de
  // montar, com este perfil e estas contratações. Tool nova entra sozinha.
  const escrevem = ferramentasSemEnsaio.filter((n) => !TOOLS_SO_LEITURA.includes(n));
  chk(`o turno normal deu ${ferramentasSemEnsaio.length} ferramentas ao modelo`, ferramentasSemEnsaio.length >= 5,
    JSON.stringify(ferramentasSemEnsaio));
  // Rejeita a lista vazia ANTES de comparar: se nenhuma ferramenta escrevesse,
  // "nenhuma que escreve passou" seria verdade sem o filtro existir.
  chk('existem ferramentas que ESCREVEM para filtrar', escrevem.length > 0, JSON.stringify(escrevem));
  chk('...incluindo `gerenciar_pedido`, que cria pedido de cliente', escrevem.includes('gerenciar_pedido'),
    JSON.stringify(escrevem));

  const envios3 = [];
  await executarTurno({ ...deps, chatwoot: chatwootMudo(envios3) }, {
    tenant, conversationId: CONVERSA_DE_ENSAIO, filaIds: [], mensagens: msg('quero um pao'), ensaio: { historico: [] },
  });
  const passaram = visto.ferramentas;
  const vazaram = passaram.filter((n) => escrevem.includes(n));
  chk('nenhuma ferramenta que escreve chegou ao modelo no ensaio', vazaram.length === 0, JSON.stringify(vazaram));
  chk('o ensaio recebeu as de leitura que o perfil tem',
    passaram.length === ferramentasSemEnsaio.filter((n) => TOOLS_SO_LEITURA.includes(n)).length && passaram.length > 0,
    JSON.stringify(passaram));
  chk('`busca_conhecimento` continua chegando (senão o ensaio não testa nada)',
    passaram.includes('busca_conhecimento'), JSON.stringify(passaram));
  chk('`consultar_catalogo` também (é leitura, e é metade das perguntas)',
    passaram.includes('consultar_catalogo'), JSON.stringify(passaram));

  // =========================================================================
  console.log('\n=== 4. A memória vem do PEDIDO, não da conversa real ===\n');

  // Primeiro provo que a conversa real TEM memória — senão o item seguinte
  // seria verdadeiro por vacuidade, que é o defeito mais comum deste repo.
  await executarTurno({ ...deps, chatwoot: chatwootMudo([]) }, {
    tenant, conversationId: CONVERSA_REAL, filaIds: [], mensagens: msg('e de novo'),
  });
  chk('a conversa real tem memória (contraprova do item seguinte)', visto.historico.length > 0,
    JSON.stringify(visto.historico.map((m) => m.papel)));

  await executarTurno({ ...deps, chatwoot: chatwootMudo([]) }, {
    tenant, conversationId: CONVERSA_REAL, filaIds: [], mensagens: msg('tem memoria?'), ensaio: { historico: [] },
  });
  chk('ensaio com histórico vazio NÃO lê a memória da conversa real', visto.historico.length === 0,
    JSON.stringify(visto.historico));

  const hist = [{ papel: 'human', texto: 'quanto custa o pao?' }, { papel: 'ai', texto: 'custa dez reais' }];
  await executarTurno({ ...deps, chatwoot: chatwootMudo([]) }, {
    tenant, conversationId: CONVERSA_DE_ENSAIO, filaIds: [], mensagens: msg('e amanha?'), ensaio: { historico: hist },
  });
  chk('o histórico do pedido chega ao modelo', visto.historico.length === 2, JSON.stringify(visto.historico));
  chk('...com o conteúdo e o papel certos',
    visto.historico[0]?.papel === 'human' && visto.historico[1]?.texto === 'custa dez reais',
    JSON.stringify(visto.historico));

  // =========================================================================
  console.log('\n=== 5. O trace fica, e separável do que é real ===\n');

  const porAcao = Object.fromEntries((await q(
    `select acao, count(*)::int n from public.agente_turnos where tenant_id=$1 group by 1`, [tenantId]))
    .map((x) => [x.acao, x.n]));
  chk('os turnos de ensaio estão no trace como `ensaio`', (porAcao.ensaio ?? 0) >= 4, JSON.stringify(porAcao));
  chk('os turnos reais continuam `processar` (o trace não virou tudo ensaio)',
    (porAcao.processar ?? 0) >= 2, JSON.stringify(porAcao));
  const passos = (await q(`select count(*)::int n from public.agente_passos p
      join public.agente_turnos a on a.id = p.turno_id
     where a.tenant_id = $1 and a.acao = 'ensaio'`, [tenantId]))[0].n;
  chk('os passos do ensaio ficam (é o que se olha para diagnosticar)', passos > 0, String(passos));

  // =========================================================================
  console.log('\n=== 6. O prompt é o DE VERDADE ===\n');

  // Se o ensaio montasse um prompt próprio, ele estaria medindo a si mesmo.
  chk('o system message do ensaio contém o prompt do tenant',
    (visto.systemMessage ?? '').includes('atendente da loja de teste'), (visto.systemMessage ?? '').slice(0, 80));
  chk('...e o wrapper de sistema também (é o prompt montado, não só o campo)',
    (visto.systemMessage ?? '').includes('INSTRUÇÕES DE SISTEMA'), (visto.systemMessage ?? '').slice(0, 80));
} finally {
  // Reprova quando não limpa: em 14/10 o teste irmão (`assistente-conversa`)
  // saiu VERDE com 62 asserções imprimindo "removido: NAO", e o tenant de
  // teste ficou em produção. Arrumação que não mede se arrumou é a mesma
  // armadilha do helper que não muta e devolve sucesso.
  if (tenantId) {
    await pool.query(`delete from public.tenants where id = $1 and slug like 'zz-ensaio-%'`, [tenantId]);
    const sobrou = (await pool.query('select count(*)::int n from public.tenants where id = $1', [tenantId])).rows[0].n;
    chk('o tenant efêmero foi REMOVIDO', sobrou === 0, `ainda existe: ${SLUG} (${tenantId})`);
  }
  await pool.end();
}

console.log(`\n${falhas.length ? 'FALHOU' : 'passaram'}: ${ok} ok, ${falhas.length} falhas`);
if (falhas.length) { for (const f of falhas) console.log('  - ' + f); process.exit(1); }
