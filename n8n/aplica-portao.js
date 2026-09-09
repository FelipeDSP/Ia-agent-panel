// ============================================================================
// APLICA PORTAO — corpo do no Code que roda entre o "Estado do Pedido" e o
// "Credencial (resposta)".
//
// ESTE ARQUIVO E A FONTE. A copia dentro do JSON do workflow e injetada; editar
// o no pela UI do n8n perde a alteracao. (Hoje a injecao e feita pelo script de
// entrega; a linha no `gerar-principal.mjs` e trabalho separado e autorizado a
// parte — ver o rodape deste arquivo.)
//
// ----------------------------------------------------------------------------
// O QUE ELE DECIDE, E POR QUE ELE EXISTE
// ----------------------------------------------------------------------------
// O modelo afirma que registrou pedido sem ter chamado ferramenta nenhuma. Oito
// ocorrencias, quatro com dinheiro afirmado a mais, duas com cliente real.
// Prompt ja foi descartado: a regra "so afirme depois do retorno da ferramenta"
// existe e foi violada oito vezes. Regex sozinha tambem: a frase legitima e a
// fabricada sao IDENTICAS —
//
//   "seu pedido ficou: - 10 paes de queijo - R$ 15,00  Total: R$ 15,00"
//
// aparece nas duas situacoes. O que separa e o BANCO, e por isso este no roda
// depois de uma consulta e nao depois de uma regex.
//
// ----------------------------------------------------------------------------
// AS DUAS REGRAS. NAO EXISTE UMA TERCEIRA.
// ----------------------------------------------------------------------------
//   REGRA 1 (modalidade C) — afirma efeito consumado e NAO houve escrita neste
//                            turno  ->  BARRA.
//   REGRA 2 (modalidade B) — apresenta um total que diverge do
//                            `total_centavos` do rascunho  ->  BARRA.
//
// NAO acrescente uma camada de "valor nao reconhecido" (barrar valor que nao
// existe no catalogo). Ela FOI MEDIDA E DESCARTADA: com 20 precos distintos no
// `emporio`, os quatro casos reais — R$ 42,50 / R$ 60,00 / R$ 279,60 /
// R$ 249,80 — caem TODOS dentro do conjunto de valores legitimos que o catalogo
// consegue somar. Cobertura 0 de 4. Ela custa falso positivo e nao paga nada.
//
// ----------------------------------------------------------------------------
// AS DUAS ASSIMETRIAS SAO OPOSTAS. NAO AS ALINHE.
// ----------------------------------------------------------------------------
// Quem mexer numa vai querer deixar a outra igual. Nao pode, e o motivo e que
// elas decidem coisas diferentes:
//
//   GATILHO (`ehCandidata`) — decide se a mensagem e sequer avaliada.
//     LARGO. Marca de efeito consumado OU qualquer valor monetario.
//     Errar para MAIS custa nada (a consulta ao banco ja aconteceu, e uma
//     candidata que passa nas duas regras segue intacta).
//     Errar para MENOS deixa passar fabricacao, que e o estado de hoje.
//
//   MARCADOR DE TOTALIDADE (`totaisAfirmados`) — decide se a REGRA 2 avalia.
//     ESTREITO. So o lema "total".
//     Errar para MAIS barra venda legitima: a confirmacao honesta mais comum
//     lista subtotais sem total ("10 paes a R$ 15,00, 1 queijo a R$ 20,00 e 1
//     iogurte a R$ 3,50?") e nao pode ser tocada.
//
// Medido no corpus real:
//   - os quatro casos usam "Total:" ou "Totalizando"  -> o estreito pega 4 de 4;
//   - a confirmacao com subtotais nao tem o lema      -> o estreito nao a toca.
//
// E NAO use "Total:" literal: tres variantes reais se perderiam —
// "total R$ 18,00", "O total ficou R$ 75,00", "por R$ 4,50 no total".
//
// ----------------------------------------------------------------------------
// DINHEIRO E INTEIRO EM CENTAVOS EM TODO O CAMINHO
// ----------------------------------------------------------------------------
// O banco devolve centavos, a comparacao e em centavos, e a formatacao para
// real acontece so na montagem do texto (`brl`). Comparar float de reais
// reintroduz 0.1 + 0.2 na decisao de barrar uma venda.
// ============================================================================

const estado = $input.first().json ?? {};
const est = (() => {
  try { return $('Estima Tokens').first().json; } catch (e) { return {}; }
})();

const textoModelo = String(est.output ?? '');

// O que o banco disse. Nomes iguais aos da funcao `api_n8n_estado_pedido`.
//
// `tem_pedido`, e nao `tem_rascunho`: a referencia passou a ser o pedido TOCADO
// no turno, em qualquer status, e so entao o rascunho. Sem isso o turno do
// FECHAMENTO ficava sem referencia — o `fechar_pedido` tira o rascunho no exato
// turno em que o valor final e dito ao cliente, e foi por ali que o R$ 42,50 de
// 21/08 escapou.
const temPedido = estado.tem_pedido === true;
const statusPedido = estado.pedido_status ?? null;
const totalBanco = Number.isFinite(estado.total_centavos) ? estado.total_centavos : 0;
const itens = Array.isArray(estado.itens) ? estado.itens : [];
const escreveuNesteTurno = estado.escreveu_neste_turno === true;
const barrouAnterior = estado.barrou_anterior === true;

// ----------------------------------------------------------------------------
// DINHEIRO
// ----------------------------------------------------------------------------
const brl = (centavos) =>
  'R$ ' + (centavos / 100).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');

// Valores monetarios no texto, com a POSICAO — a posicao e o que permite ligar
// um valor ao lema "total" que esta perto dele.
const RE_DINHEIRO = /R\$\s?(\d{1,3}(?:\.\d{3})*|\d+),(\d{2})/g;
function valoresNoTexto(txt) {
  const out = [];
  let m;
  RE_DINHEIRO.lastIndex = 0;
  while ((m = RE_DINHEIRO.exec(txt)) !== null) {
    const inteiros = m[1].replace(/\./g, '');
    out.push({ centavos: parseInt(inteiros, 10) * 100 + parseInt(m[2], 10), i: m.index, fim: m.index + m[0].length });
  }
  return out;
}

// ----------------------------------------------------------------------------
// O GATILHO — LARGO (ver o cabecalho)
// ----------------------------------------------------------------------------
// Marca de efeito CONSUMADO. Nao inclui verbo no futuro nem oferta: "vou
// anotar" e "quer que eu anote?" nao afirmam nada ainda.
const RE_CONSUMADO = new RegExp(
  '(anotei|anotad[oa]|adicionei|acrescentei|inclu[ií]|coloquei|registrei|registrad[oa]'
  + '|reservei|reservad[oa]|separei|separad[oa]|removi|tirei|cancelei|cancelad[oa]'
  + '|fech(ei|ado|ada)|finalizad[oa]|confirmad[oa]|prontinho'
  + '|seu pedido|pedido (esta|está|ficou|foi))',
  'i',
);

// Formas que DESFAZEM a afirmacao dentro da mesma frase: pergunta, oferta,
// futuro, condicional. Sem isto, "Quer que eu ja coloque no seu pedido?" seria
// lida como efeito consumado — e ela e o oposto: e o agente pedindo permissao.
const RE_NAO_CONSUMADO = /(\?|quer que|posso |gostaria|deseja|vou |irei |se voc[eê]|caso |quando voc[eê]|prefere)/i;

function frases(txt) {
  return String(txt).split(/(?<=[.!?\n])\s*/).filter((f) => f.trim() !== '');
}

// CONTEXTO DE PEDIDO. Sem isto a regra 1 barra mensagem que nao e sobre venda
// nenhuma, e ha caso real: o `fortalize` escreveu
//
//   "Atualizando a lista das vacinas ..., incluindo a influenza anual"
//
// e `inclu[ií]` casa dentro de "incluindo". Era o falso positivo conhecido da
// D1 (§6 da PENDENCIA-VENDA-AFIRMADA-SEM-TOOL) e, num portao que BARRA, ele
// deixaria um tenant de saude sem resposta.
//
// A guarda e de contexto, nao de vocabulario: a frase tem de falar de pedido,
// de carrinho ou de dinheiro. Isso mantem o gatilho largo onde importa —
// "Separei 2 pedacos ..., totalizando R$ 15,00" nao tem a palavra pedido e
// continua sendo pego pelo `R$` — e tira o que nao e venda.
const RE_CONTEXTO_PEDIDO = /(pedido|carrinho|R\$)/i;

// Afirma efeito consumado se ALGUMA frase traz a marca, com contexto de pedido
// e sem desfazer a afirmacao.
function afirmaEfeitoConsumado(txt) {
  return frases(txt).some((f) =>
    RE_CONSUMADO.test(f) && RE_CONTEXTO_PEDIDO.test(f) && !RE_NAO_CONSUMADO.test(f));
}

function ehCandidata(txt) {
  return afirmaEfeitoConsumado(txt) || valoresNoTexto(txt).length > 0;
}

// ----------------------------------------------------------------------------
// O MARCADOR DE TOTALIDADE — ESTREITO (ver o cabecalho)
// ----------------------------------------------------------------------------
// So o lema "total". Para cada ocorrencia dele, o valor monetario MAIS PROXIMO
// dentro de uma janela — e nao "todos os valores da janela", que colocaria um
// upsell mencionado logo depois ("e o doce sai por R$ 15,00") na conta.
const RE_LEMA_TOTAL = /\btotal(izando|iza|izou|izam)?\b/gi;
const JANELA = 40;

function totaisAfirmados(txt) {
  const valores = valoresNoTexto(txt);
  if (valores.length === 0) return [];
  const achados = [];
  let m;
  RE_LEMA_TOTAL.lastIndex = 0;
  while ((m = RE_LEMA_TOTAL.exec(txt)) !== null) {
    const fimLema = m.index + m[0].length;
    // O valor DEPOIS do lema tem precedencia sobre o de antes, e nao e questao
    // de estilo — foi um defeito real, pego pelo caso de controle da §8 do
    // teste. Em
    //
    //   "- 1x NR 06 — R$ 69,90\n\nTotal: R$ 279,60"
    //
    // os dois valores ficam a MESMA distancia do lema (dois caracteres), e o
    // desempate por "primeiro encontrado" elegia o R$ 69,90 — o subtotal da
    // linha anterior. O portao barrava uma venda correta comparando o total do
    // banco contra o preco de um item.
    //
    // "Total: X" e "totalizando X" poem o valor depois; so "por X no total" o
    // poe antes. Entao: procura depois primeiro, e so cai para tras se nao
    // houver nada depois dentro da janela.
    let melhor = null;
    let dist = Infinity;
    for (const v of valores) {
      if (v.i < fimLema) continue;
      const d = v.i - fimLema;
      if (d <= JANELA && d < dist) { dist = d; melhor = v; }
    }
    if (!melhor) {
      for (const v of valores) {
        if (v.fim > m.index) continue;
        const d = m.index - v.fim;
        if (d <= JANELA && d < dist) { dist = d; melhor = v; }
      }
    }
    if (melhor) achados.push(melhor.centavos);
  }
  return achados;
}

// ----------------------------------------------------------------------------
// O BLOCO DO PEDIDO — com ITENS, nunca so o total
// ----------------------------------------------------------------------------
// Quantidade errada com total certo e o formato EXATO de uma das ocorrencias
// reais (`emporio` conversa 3: 6 milho + 2 cenoura no banco, 3 + 1 no texto).
// Um bloco que mostrasse so "Total: R$ 45,00" teria passado por cima dela.
function blocoPedido() {
  const linhas = itens.map((i) =>
    `• ${i.nome} — ${i.quantidade} × ${brl(i.preco_unit_centavos)} = ${brl(i.subtotal_centavos)}`);
  return ['📋 Seu pedido', ...linhas, `Total: ${brl(totalBanco)}`].join('\n');
}

// ----------------------------------------------------------------------------
// A DECISAO
// ----------------------------------------------------------------------------
const candidata = ehCandidata(textoModelo);

// REGRA 1 — afirmou efeito consumado sem escrita neste turno.
const afirmou = candidata && afirmaEfeitoConsumado(textoModelo);
const regra1Barra = afirmou && !escreveuNesteTurno;

// REGRA 2 — total afirmado diverge do banco.
// So avalia com rascunho e total maior que zero: sem isso nao ha com o que
// comparar, e a mensagem de pre-venda ("o pao de queijo sai por R$ 1,50") deixa
// de ser candidata a divergencia por nao existir referencia.
const regra2Avaliavel = candidata && temPedido && totalBanco > 0;
const totais = regra2Avaliavel ? totaisAfirmados(textoModelo) : [];
const totalAfirmado = totais.length ? Math.max(...totais) : null;
const regra2Avaliada = regra2Avaliavel && totalAfirmado !== null;
const regra2Barra = regra2Avaliada && totalAfirmado !== totalBanco;

const barrou = regra1Barra || regra2Barra;
const veredito = regra1Barra ? 'barrado_regra_1' : (regra2Barra ? 'barrado_regra_2' : 'passou');

// ----------------------------------------------------------------------------
// O TEXTO QUE SAI
// ----------------------------------------------------------------------------
// A substituta nao pede desculpa e nao explica erro interno: mostra o estado
// real e devolve o turno ao cliente. Tom informal, do `emporio`.
//
// NOTA DE ESCOPO: o tom esta aqui, em codigo, e nao por tenant. O lugar natural
// para tornar isso configuravel e `tenant_tools.config` da tool `vendas`, do
// mesmo jeito que `transferir_humano` guarda horario e notificacao. Nao foi
// feito: e trabalho proprio, e ate la um tenant de tom formal recebe este texto.
function mensagemSubstituta() {
  if (!temPedido) {
    return [
      'Deixa eu confirmar uma coisa antes de seguir 😊',
      '',
      'Ainda nao tenho nenhum item anotado no seu pedido aqui.',
      '',
      'Me diz o que voce quer que eu anote certinho?',
    ].join('\n');
  }
  return [
    'Deixa eu confirmar seu pedido antes de fechar 😊',
    '',
    blocoPedido(),
    '',
    'Ta certo assim? Se estiver, eu fecho pra retirada.',
  ].join('\n');
}

// O bloco vai quando o estado MUDOU neste turno, ou quando o portao barrou.
// Nao vai em toda mensagem: repetir o pedido a cada linha da conversa vira
// ruido e treina o cliente a nao ler.
const anexaBloco = !barrou && escreveuNesteTurno && temPedido;

let saida;
if (barrou) {
  saida = mensagemSubstituta();
} else if (anexaBloco) {
  saida = textoModelo.trim() + '\n\n' + blocoPedido();
} else {
  saida = textoModelo;
}

// ----------------------------------------------------------------------------
// DUAS BARRADAS SEGUIDAS -> TRANSFERE
// ----------------------------------------------------------------------------
// A nota privada carrega OS DOIS, rotulados. Nao substitui um pelo outro: a
// DIVERGENCIA e a informacao que leva a conversa ao humano. Mandar so o estado
// do banco esconderia o que o cliente leu; mandar so o texto do modelo e o que
// o handoff ja faz hoje pelo `$fromAI('resumo')`, e essa e a fonte contaminada
// (§8 da PENDENCIA-VENDA-AFIRMADA-SEM-TOOL).
const transferir = barrou && barrouAnterior;
const notaPrivada = transferir
  ? [
      '🤖 *Portao de venda: duas mensagens barradas seguidas*',
      '',
      '*Estado de fato (banco):*',
      temPedido ? blocoPedido() : 'Nenhum pedido aberto nesta conversa.',
      '',
      '*O que o agente afirmou (nao enviado ao cliente):*',
      textoModelo.trim() || '(vazio)',
      '',
      `Motivo: ${veredito}.`,
    ].join('\n')
  : null;

// ----------------------------------------------------------------------------
// O REGISTRO — nunca so a substituta
// ----------------------------------------------------------------------------
// Gravar apenas o texto corrigido cegaria o cruzamento texto x banco, que e a
// unica segunda fonte de deteccao que existe. E exatamente o erro documentado
// em docs/VAZAMENTO-USED-TOOLS.md, onde o filtro de saida passou a gravar o
// texto limpo e a consulta de frequencia ficou cega.
//
// O veredito viaja no `componentes`, canal desenhado pela migracao 42
// (`p_componentes jsonb`): componente novo vira coluna sem `drop function`, sem
// aridade ambigua e sem grant para reconceder.
let componentes = {};
try { componentes = JSON.parse(est.componentes_json ?? '{}'); } catch (e) { componentes = {}; }

componentes.portao = {
  veredito,
  // `avaliada` e diferente de `barrou`, e a diferenca e o alarme: o marcador de
  // totalidade depende de COMO o system_prompt manda o agente escrever. Se o
  // cliente editar o prompt e a forma mudar, a cobertura cai a zero em silencio.
  // Regra que nunca dispara e regra que nunca e avaliada parecem iguais no log —
  // e so este campo as separa.
  regra1_avaliada: candidata,
  regra2_avaliada: regra2Avaliada,
  candidata,
  afirmou_efeito_consumado: afirmou,
  escreveu_neste_turno: escreveuNesteTurno,
  tem_pedido: temPedido,
  pedido_status: statusPedido,
  total_banco_centavos: totalBanco,
  total_afirmado_centavos: totalAfirmado,
  bloco_anexado: anexaBloco,
  transferiu: transferir,
  // O texto BRUTO so viaja quando houve substituicao — nos outros casos ele e
  // igual ao `conteudo` da linha e duplicar seria pagar bytes por nada.
  bruto: barrou ? textoModelo : null,
};

return [{
  json: {
    ...est,
    output: saida,
    componentes_json: JSON.stringify(componentes),
    _portao: componentes.portao,
    _portao_transferir: transferir,
    _portao_nota_privada: notaPrivada,
  },
}];

// ----------------------------------------------------------------------------
// O QUE FALTA LIGAR NO GERADOR (trabalho separado, precisa de autorizacao)
// ----------------------------------------------------------------------------
// `scripts/gerar-principal.mjs` nao seta `description` de 7 das 8 ferramentas,
// e nao conhece este no. Enquanto nao houver linha la, ESTE ARQUIVO e a fonte e
// a copia no JSON e injetada pelo script de entrega — o que faz do corpo do no
// mais um campo orfao, na classe da docs/PENDENCIA-GERADOR-CAMPO-ORFAO.md.
// Registrado de proposito: e divida conhecida, nao esquecimento.
