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
//   execucao   chamadas ao modelo   real (soma)   registrado   erro
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
// 2. BASE SUBESTIMADA. A primeira chamada real custou 1554 tokens; a estimativa
//    de texto + TOKENS_FERRAMENTAS deu 1045. Faltam ~509, que sao os schemas das
//    tools (a constante esta velha) mais a janela de memoria do Redis, que o no
//    nao enxerga. NAO corrigido ainda — depende da sonda abaixo.
//
// 3. MEMORIA INVISIVEL. Duas execucoes com conteudo de memoria diferente
//    estimaram o MESMO valor (1045), enquanto o real diferiu em 306 tokens.
//
// ----------------------------------------------------------------------------
// A SONDA
// ----------------------------------------------------------------------------
// O numero exato existe: `tokenUsageEstimate` no sub-no "OpenAI Chat Model", uma
// entrada por chamada. A tentativa anterior concluiu que um no Code no fluxo
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
//   3948813   real 1554 = 2901/r + S          (conversa nova, memoria ~0)
//   3949288   real 2036 = (2901+1500)/r + S
//   subtraindo:    482 = 1500/r   ->   r = 3,112   ->   S = 622
//
// Conferido contra as quatro execucoes disponiveis:
//
//   3948813   previsto  1556   real  1554   +0,1%
//   3949288   previsto  2040   real  2036   +0,2%
//   3948994   previsto  3775   real  3828   -1,4%   (2 chamadas)
//   3948818   previsto 10485   real 10481    0,0%   (6 chamadas, a venda)
//
// Antes desta calibracao o mesmo calculo errava de 1,5x a 10x.
// ============================================================================

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
let perfil = 'basico';
try {
  perfil = $('Tools Ativas').item.json.perfil ?? 'basico';
} catch (e) { /* sem o no no contexto: assume basico */ }

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
let real = null;
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
      real = {
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
  systemPrompt = $('Resolve Tenant').item.json.system_prompt ?? '';
} catch (e) { /* sem tenant no contexto: segue sem o system_prompt */ }

let mensagens = '';
try {
  const lista = $('Lista Depois').item.json.lista_depois;
  mensagens = Array.isArray(lista) ? lista.join('\n') : (lista ?? '');
} catch (e) {
  mensagens = agent?.input ?? '';
}

// Quantas vezes o modelo foi chamado. `intermediateSteps` exige
// `returnIntermediateSteps: true` nas opcoes do AI Agent — sem isso caimos em 1,
// que e o comportamento antigo (e o erro antigo).
const passos = Array.isArray(agent?.intermediateSteps) ? agent.intermediateSteps.length : 0;
const chamadas = 1 + passos;


// Tamanho da janela de memoria que o modelo recebe, vindo da migracao 29 pelo
// no que ja existia (Sync Conversa) — sem query nova num caminho que ja tem
// tres. Era a maior causa restante de erro: ~970 tokens por mensagem, e
// crescendo com o tamanho da conversa, o que tornava o rateio nao-uniforme.
let historicoChars = 0;
try {
  historicoChars = Number($('Sync Conversa').item.json.historico_chars) || 0;
} catch (e) { /* sem sync no contexto: segue sem memoria contabilizada */ }
const base = emTokens(WRAPPER + systemPrompt + mensagens) + TOKENS_FERRAMENTAS + Math.ceil(historicoChars / 4);

// Cada chamada reenvia o prompt inteiro; o historico cresce a cada round-trip.
const estimado_entrada = chamadas * base + CRESCIMENTO_POR_CHAMADA * ((chamadas * (chamadas - 1)) / 2);
const estimado_saida = emTokens(textoSaida);

// ----------------------------------------------------------------------------
// 3. Real quando der, estimado quando nao
// ----------------------------------------------------------------------------
const tokens_entrada = real ? real.entrada : estimado_entrada;
const tokens_saida = real ? real.saida : estimado_saida;

return [{
  json: {
    output: textoSaida,
    tokens_entrada,
    tokens_saida,
    _fonte_tokens: real ? 'api_real' : 'estimativa_com_multiplicidade',
    // Diagnostico: some daqui quando a sonda tiver dado veredicto e o caminho
    // estiver decidido. Ate la, e o que responde se da para parar de estimar.
    _sonda: sonda,
    _chamadas: real ? real.chamadas : chamadas,
    _estimado_entrada: estimado_entrada,
    _historico_chars: historicoChars,
    _perfil: perfil,
  },
}];
