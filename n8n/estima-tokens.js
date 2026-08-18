// ============================================================================
// ESTIMA TOKENS — corpo do no Code que roda logo apos o "AI Agent"
//
// ESTE ARQUIVO E A FONTE. O JSON do workflow recebe uma copia injetada por
// scripts/gerar-principal-vendas.mjs. Editar o no pela UI do n8n e perder a
// alteracao no proximo `node scripts/gerar-principal-vendas.mjs` — edite aqui.
//
// O motivo de existir como arquivo: ate 2026-08-11 este codigo vivia como string
// dentro do JSON do workflow, onde nao da para revisar em diff nem rodar lint. O
// bug de multiplicidade abaixo passou meses invisivel em parte por isso.
//
// ----------------------------------------------------------------------------
// O QUE ESTE NO CALCULA, E O ERRO QUE ELE TINHA
// ----------------------------------------------------------------------------
// Ele estima os tokens de uma interacao para ratear custo entre clientes. Nao e
// fatura — mas precisa ser CONSISTENTE entre tenants, senao o rateio mente.
//
// Medido em 2026-08-11 contra execucoes reais, ele NAO era consistente:
//
//   execucao   chamadas ao modelo   n8n (soma)    registrado   erro
//   3948813            1                1554         1045       1,5x
//   3948994            2                3828         1045       3,7x
//   3948818            6               10481         1049      10,0x
//
// TRES causas, em ordem de tamanho:
//
// 1. MULTIPLICIDADE (a de 10x). Ele contava UMA chamada ao modelo. Mas cada tool
//    call e outro round-trip que reenvia o prompt inteiro: a venda fez 6. E o
//    erro cresce com o uso de ferramenta — ou seja, quem vende era subcobrado
//    contra quem so conversa. Corrigido aqui.
//
// 2. BASE SUBESTIMADA. A primeira chamada custou 1554 tokens pelo n8n; a estimativa
//    de texto + TOKENS_FERRAMENTAS deu 1045. Faltam ~509, que sao os schemas das
//    tools (a constante esta velha) mais a janela de memoria do Redis, que o no
//    nao enxerga. NAO corrigido ainda — depende da sonda abaixo.
//
// 3. MEMORIA INVISIVEL. Duas execucoes com conteudo de memoria diferente
//    estimaram o MESMO valor (1045), enquanto o do n8n diferiu em 306 tokens.
//
// ----------------------------------------------------------------------------
// "REAL" ERA MENTIRA — VOCABULARIO CORRIGIDO EM 18/08/2026
// ----------------------------------------------------------------------------
// Ate hoje este arquivo chamava de "real" o numero do sub-no. Ele NAO vem da
// API: o campo se chama `tokenUsageEstimate`, e essa chave e o caminho de
// FALLBACK do tracing do n8n — aparece quando a resposta do modelo nao traz
// `usage`, e ai o n8n estima a partir do texto. Se `usage` viesse, a chave seria
// `tokenUsage`.
//
// Nao e configuracao daqui: nao ha nenhuma chave `stream` nos 56 nos do
// workflow e o gatilho e webhook comum. A causa e interna ao AgentExecutor do
// LangChain, que roda o modelo em streaming por padrao — e chamada em streaming
// nao devolve `usage` sem `stream_options.include_usage`.
//
// O QUE MUDA E O QUE NAO MUDA. Nao invalida a calibracao: a estimativa do n8n e
// melhor que a nossa (ela ve o prompt ja montado, com schema de tool e janela de
// memoria dentro), e estar a +-1,4% de uma medida melhor continua valendo. Muda
// o vocabulario, que ensinava errado quem lesse: em nenhum ponto desta cadeia
// existe um numero que a OpenAI cobra. A unica fonte indiscutivel e a fatura —
// ver docs/TOKENS-REAIS-PARA-COBRANCA.md.
//
// ----------------------------------------------------------------------------
// A SONDA
// ----------------------------------------------------------------------------
// O numero do sub-no "OpenAI Chat Model" (`tokenUsageEstimate`, estimativa do
// n8n) tem uma entrada por chamada. A tentativa anterior concluiu que um no Code no fluxo
// principal nao alcanca sub-no. Isso e testado aqui de novo, com varias formas
// de acesso e dentro de try/catch — se alguma funcionar, o valor exato substitui
// toda a estimativa e as tres causas acima somem de uma vez.
//
// VEREDICTO (execucao 3949227): NAO da. O no e encontrado, mas nao tem saida
// `main` — "No data found from `main` input" nas duas formas. A sonda fica no
// codigo porque o custo e zero e uma versao futura do n8n pode mudar isso; se
// mudar, `_sonda` avisa sozinha.
//
// ----------------------------------------------------------------------------
// CALIBRACAO (11/08/2026) — como 3,11 e 622 sairam
// ----------------------------------------------------------------------------
// Duas execucoes com o MESMO texto de prompt e memorias diferentes formam um
// sistema de duas equacoes, e ai os dois desconhecidos se separam:
//
//   3948813   n8n 1554 = 2901/r + S          (conversa nova, memoria ~0)
//   3949288   n8n 2036 = (2901+1500)/r + S
//   subtraindo:    482 = 1500/r   ->   r = 3,112   ->   S = 622
//
// Conferido contra as quatro execucoes disponiveis:
//
//   3948813   previsto  1556   n8n  1554   +0,1%
//   3949288   previsto  2040   n8n  2036   +0,2%
//   3948994   previsto  3775   n8n  3828   -1,4%   (2 chamadas)
//   3948818   previsto 10485   n8n 10481    0,0%   (6 chamadas, a venda)
//
// Antes desta calibracao o mesmo calculo errava de 1,5x a 10x.
// ============================================================================

// ----------------------------------------------------------------------------
// POR QUE `.first()` E NAO `.item` (12/08/2026)
// ----------------------------------------------------------------------------
// O acessor `.item` resolve por ITEM LINKING: o n8n rastreia a linhagem do item
// corrente ate o no citado. (Escrito assim, sem a forma literal com cifrao e
// parenteses, porque n8n-validar.mjs varre comentario e acusaria referencia
// orfa a um no chamado "No".) A cadeia do LPOP (Split Out -> pop -> Limit ->
// Postgres) quebra essa linhagem, e a partir dai `.item` para de resolver.
//
// Aqui o estrago era mudo: cada leitura estava dentro de um try/catch com
// comentario vazio, entao o no seguia com system_prompt '' e memoria 0 e o
// rateio simplesmente encolhia. O `_faltou` existe para isso nao se repetir.
//
// Todos os nos citados emitem EXATAMENTE UM item por execucao (um GET no Redis,
// uma linha do Postgres, um item do Code), entao `.first()` e equivalente ao
// `.item` quando o linking funciona -- e continua funcionando quando nao.
//
// A saida do agent vem por $input, e NAO por referencia ao agent pelo nome: a
// fatia 3 tem DOIS agents e so um executa. Referenciar por nome quebraria no
// perfil que nao casasse com o nome escrito — e o $input nao precisa saber de
// quem veio. (O nome nao aparece nem aqui de proposito: n8n-validar.mjs varre
// comentario tambem, e acusaria referencia orfa.)
const agent = $input.first().json;
const textoSaida = agent?.output ?? '';

// Qual perfil executou. Vem do `Tools Ativas`, que e nome fixo mas SEMPRE roda:
// esta antes do Switch, no caminho unico. Fallback `basico` de proposito — aqui
// e MEDICAO, e errar cobrando a menos e melhor que a mais. (No roteamento o
// sinal e oposto: la nao ha fallback, ver o no `Vende?`.)
// Toda leitura de outro no que falhar entra aqui e sai no `_faltou`. Antes os
// catch eram comentario vazio: o no seguia com system_prompt '' e memoria 0, e
// o rateio mentia sem nada no log. Foi assim que o `.item` quebrado passou
// despercebido — o unico sintoma era um numero um pouco menor.
const faltou = [];

let perfil = 'basico';
try {
  perfil = $('Tools Ativas').first().json.perfil ?? 'basico';
} catch (e) { faltou.push('Tools Ativas:' + String(e && e.message).slice(0, 40)); }

// Os dois wrappers e os dois S saem do gerador, da mesma fonte do System Message
// de cada agent. `npm run n8n:sincronia` falha se divergirem.
const WRAPPERS = __WRAPPERS__;
const S_POR_PERFIL = __PERFIS_S__;

const WRAPPER = WRAPPERS[perfil] ?? WRAPPERS.basico;

// Schemas das ferramentas, POR PERFIL — cada agent carrega um conjunto diferente
// e custa diferente. 622 (7 tools) foi MEDIDO pelo metodo das duas equacoes;
// 266 (3 tools) ainda e regra de tres e sera medido assim que houver execucao no
// perfil basico. Com `r` ja conhecido, uma execucao basta para resolver.
const TOKENS_FERRAMENTAS = S_POR_PERFIL[perfil] ?? S_POR_PERFIL.basico;

// Crescimento medio do prompt a cada round-trip de tool (resultado da tool +
// mensagem do assistente). Calibrado contra as 3 execucoes reais: com 55, a
// formula errou 0,0% / -1,4% / 0,0%.
const CRESCIMENTO_POR_CHAMADA = 55;

// 3,11 chars/token, MEDIDO para portugues acentuado — nao os 4 da heuristica
// generica, que subestimava em ~29%. O tokenizer da OpenAI quebra acento em mais
// de um token, e o system prompt daqui e todo em portugues.
const CHARS_POR_TOKEN = 3.11;
const emTokens = (t) => Math.ceil((t || '').length / CHARS_POR_TOKEN);

// ----------------------------------------------------------------------------
// 1. Sonda: o numero exato esta alcancavel?
// ----------------------------------------------------------------------------
let usoN8n = null;
let sonda = 'nao_tentada';

const formas = [
  ['all', () => $('OpenAI Chat Model').all().map((i) => i.json)],
  ['first', () => [$('OpenAI Chat Model').first().json]],
];

for (const [nome, fn] of formas) {
  try {
    const itens = fn();
    const usos = (itens || [])
      .map((j) => j?.tokenUsageEstimate ?? j?.tokenUsage ?? null)
      .filter(Boolean);
    if (usos.length > 0) {
      usoN8n = {
        chamadas: usos.length,
        entrada: usos.reduce((a, u) => a + (u.promptTokens || 0), 0),
        saida: usos.reduce((a, u) => a + (u.completionTokens || 0), 0),
      };
      sonda = `ok:${nome}`;
      break;
    }
    sonda = `vazio:${nome}`;
  } catch (e) {
    sonda = `erro:${nome}:${String(e && e.message).slice(0, 60)}`;
  }
}

// ----------------------------------------------------------------------------
// 2. Caminho estimado, com multiplicidade
// ----------------------------------------------------------------------------
let systemPrompt = '';
try {
  systemPrompt = $('Resolve Tenant').first().json.system_prompt ?? '';
} catch (e) { faltou.push('Resolve Tenant'); }

let mensagens = '';
try {
  const lista = $('Lista Depois').first().json.lista_depois;
  mensagens = Array.isArray(lista) ? lista.join('\n') : (lista ?? '');
} catch (e) {
  faltou.push('Lista Depois');
  mensagens = agent?.input ?? '';
}

// Quantas vezes o modelo foi chamado. `intermediateSteps` exige
// `returnIntermediateSteps: true` nas opcoes do AI Agent — sem isso caimos em 1,
// que e o comportamento antigo (e o erro antigo).
const passos = Array.isArray(agent?.intermediateSteps) ? agent.intermediateSteps.length : 0;
const chamadas = 1 + passos;

// ----------------------------------------------------------------------------
// 1b. SONDA B — o numero exato veio JUNTO com a saida do agent?
// ----------------------------------------------------------------------------
// A sonda A acima pergunta se da para ALCANCAR o sub-no a partir daqui, e o
// veredicto foi nao. Esta pergunta e outra: com `returnIntermediateSteps`
// ligado (esta ligado nos dois agents), o objeto que chega em $input carrega
// `messageLog` com as AIMessage de cada round-trip de tool -- e uma AIMessage
// serializada pode trazer `response_metadata.tokenUsage` e `usage_metadata`,
// que sao o campo `usage` da resposta da API, nao estimativa.
//
// Ninguem tinha olhado: este arquivo le `output` e `intermediateSteps` e mais
// nada. Entao a sonda nao procura um caminho que eu ache que existe -- ela
// VARRE o objeto inteiro atras de qualquer par (promptTokens|input_tokens) e
// (completionTokens|output_tokens), e reporta os caminhos que achou. Uma
// execucao real responde de vez, e o resultado nao depende de eu ter acertado
// o formato de serializacao da versao do n8n que roda aqui.
//
// LIMITE ESTRUTURAL, e por isso o resultado NAO entra no total automaticamente:
// `intermediateSteps` cobre os passos que chamaram ferramenta, e a chamada FINAL
// -- a que produziu `output` -- nao vira passo. Somar so o que ela achar
// subcobra, calado, que e exatamente a falha que este arquivo existe para
// impedir. Se a sonda achar N usos com N = `chamadas` - 1, o caminho e somar o
// uso reportado nos passos e estimar apenas a ultima chamada.
//
// PREVISAO REGISTRADA EM 18/08, ANTES DE QUALQUER EXECUCAO: deve achar ZERO. Se
// a chamada nao devolve `usage` -- que e o que o `tokenUsageEstimate` do sub-no
// indica --, a AIMessage tambem nao carrega `usage_metadata`. Achar zero fecha o
// caminho 1 pela mesma causa que fechou o 2; achar QUALQUER COISA refuta a
// explicacao inteira e reabre o caminho 1 como o melhor dos tres. Por isso ela
// fica no ar ate a primeira execucao: custa uma varredura de objeto e responde
// uma pergunta que esta aberta desde 11/08.
const acharUsos = (raiz) => {
  const achados = [];
  const vistos = new Set();
  const fila = [[raiz, 'json']];
  let visitados = 0;
  // Tetos: o objeto pode conter a conversa inteira, e um no Code que estoura
  // memoria derruba a mensagem do cliente. Diagnostico nunca vale isso.
  while (fila.length > 0 && visitados < 5000 && achados.length < 40) {
    const [v, caminho] = fila.shift();
    visitados++;
    if (!v || typeof v !== 'object') continue;
    if (vistos.has(v)) continue; // messageLog costuma reapontar para o mesmo objeto
    vistos.add(v);
    if (caminho.split('.').length > 16) continue;
    const entrada = v.promptTokens ?? v.input_tokens ?? v.prompt_tokens;
    const saida = v.completionTokens ?? v.output_tokens ?? v.completion_tokens;
    if (typeof entrada === 'number' || typeof saida === 'number') {
      achados.push({ caminho, entrada: Number(entrada) || 0, saida: Number(saida) || 0 });
      continue; // achou o uso; descer dentro dele so duplicaria
    }
    for (const k of Object.keys(v)) fila.push([v[k], caminho + '.' + k]);
  }
  return { achados, visitados, truncou: fila.length > 0 };
};

let sonda_b;
try {
  const r = acharUsos(agent);
  sonda_b = r.achados.length === 0
    // Caso previsto: compacto de proposito. Um campo de diagnostico que despeja
    // objeto grande em TODA mensagem vira ruido que ninguem le -- e ai ele nao
    // avisa nada no dia em que mudar. `chaves_topo` fica porque e o que responde
    // "entao o que TEM no objeto?", que e a pergunta seguinte.
    ? { usos: 0, chaves_topo: Object.keys(agent || {}), visitados: r.visitados }
    : {
        // A previsao caiu: aqui vale despejar tudo, porque muda a decisao.
        usos: r.achados.length,
        // Batendo com `chamadas`, o uso reportado cobre tudo. Sendo
        // `chamadas` - 1, falta so a chamada final, que se estima.
        chamadas_estimadas: chamadas,
        entrada: r.achados.reduce((a, u) => a + u.entrada, 0),
        saida: r.achados.reduce((a, u) => a + u.saida, 0),
        caminhos: r.achados.map((u) => u.caminho).slice(0, 8),
        chaves_topo: Object.keys(agent || {}),
        visitados: r.visitados,
        truncou: r.truncou,
      };
} catch (e) {
  sonda_b = { erro: String(e && e.message).slice(0, 120) };
}


// Tamanho da janela de memoria que o modelo recebe, vindo da migracao 29 pelo
// no que ja existia (Sync Conversa) — sem query nova num caminho que ja tem
// tres. Era a maior causa restante de erro: ~970 tokens por mensagem, e
// crescendo com o tamanho da conversa, o que tornava o rateio nao-uniforme.
let historicoChars = 0;
try {
  historicoChars = Number($('Sync Conversa').first().json.historico_chars) || 0;
} catch (e) { faltou.push('Sync Conversa'); }
const base = emTokens(WRAPPER + systemPrompt + mensagens) + TOKENS_FERRAMENTAS + Math.ceil(historicoChars / 4);

// Cada chamada reenvia o prompt inteiro; o historico cresce a cada round-trip.
const estimado_entrada = chamadas * base + CRESCIMENTO_POR_CHAMADA * ((chamadas * (chamadas - 1)) / 2);
const estimado_saida = emTokens(textoSaida);

// ----------------------------------------------------------------------------
// 3. A estimativa do n8n quando der, a nossa quando nao
// ----------------------------------------------------------------------------
const tokens_entrada = usoN8n ? usoN8n.entrada : estimado_entrada;
const tokens_saida = usoN8n ? usoN8n.saida : estimado_saida;

return [{
  json: {
    output: textoSaida,
    tokens_entrada,
    tokens_saida,
    // O rotulo diz de QUEM e a estimativa. Nenhum dos dois valores vem da
    // OpenAI, e o nome nao pode sugerir que vem.
    _fonte_tokens: usoN8n ? 'estimativa_n8n_sub_no' : 'estimativa_nossa_com_multiplicidade',
    // Diagnostico: some daqui quando a sonda tiver dado veredicto e o caminho
    // estiver decidido. Ate la, e o que responde se da para parar de estimar.
    _sonda: sonda,
    _sonda_b: sonda_b,
    _chamadas: usoN8n ? usoN8n.chamadas : chamadas,
    _estimado_entrada: estimado_entrada,
    _historico_chars: historicoChars,
    _perfil: perfil,
    // Vazio e o esperado. Com algo dentro, o rateio esta subestimando: cada
    // entrada aqui e um pedaco do prompt que o no nao conseguiu medir.
    _faltou: faltou,
  },
}];
