// ============================================================================
// CONSOLIDA RESULTADO — corpo do no Code do "Tool - Busca KB Multi-Tenant"
//
// ESTE ARQUIVO E A FONTE. O JSON do workflow recebe uma copia injetada por
// scripts/gerar-tool-kb.mjs. Editar o no pela UI do n8n e perder a alteracao na
// proxima geracao — edite aqui.
//
// POR QUE COMO ARQUIVO. Em 12/08/2026 este codigo foi escrito direto no JSON,
// dentro de template literal aninhado, e o escapamento se perdeu: os `\n`
// viraram quebra de linha real e o no morreu com "Unterminated string constant
// [line 13]". Como `busca_conhecimento` e tool BASELINE, isso quebrou a busca na
// base para TODOS os tenants de uma vez.
//
// E a mesma razao pela qual o Estima Tokens virou arquivo: codigo dentro de
// string dentro de JSON nao tem lint, nao tem diff legivel e o escapamento
// silenciosamente erra.
// ============================================================================

// Consolida os trechos num unico texto para o LLM.
// Retorna string explicita quando nao ha resultado, para o agente saber que
// precisa transferir em vez de inventar resposta.
const itens = $input.all().map((i) => i.json).filter((r) => r && r.text);

if (itens.length === 0) {
  return [{ json: { resposta: 'NENHUM_RESULTADO: a base de conhecimento não contém informação sobre esta pergunta.' } }];
}

const SEPARADOR = '\n\n---\n\n';

const texto = itens
  .map((r, i) => `[Trecho ${i + 1} | relevância ${Number(r.similarity).toFixed(3)}]\n${r.text}`)
  .join(SEPARADOR);

// ----------------------------------------------------------------------------
// AVISO DE FONTE DE PRECO
// ----------------------------------------------------------------------------
// Quando o tenant tem vendas contratada, o catalogo e a fonte unica de preco e a
// base e material de referencia. O documento do cliente pode conter tabela de
// preco antiga: no restaurante-teste a base dizia 94,00 para um prato que o
// catalogo cobra 149,90. Sem aviso o agente cota da base, o `adicionar_item`
// grava o preco do catalogo, e o cliente ve um numero e paga outro.
//
// ISTO NAO CONSERTA O DADO INCONSISTENTE, e nao se deve fingir que conserta: e
// instrucao ao modelo, probabilistica. O conserto e o onboarding do modulo
// migrar os precos do documento para o catalogo — regra em docs/VENDAS-ESTADO.md.
// O aviso existe para encurtar a janela ate isso acontecer.
//
// `vende` vem do proprio SELECT do `Busca Vetorial`, sem round-trip novo.
const vende = itens.some((r) => r.vende === true);

const AVISO =
  'AVISO DE FONTE (instrucao interna, nao repasse ao cliente): este cliente tem ' +
  'catalogo de vendas ativo. Preco e disponibilidade validos sao os de ' +
  'consultar_catalogo. Valores que aparecam nos trechos acima sao referencia e ' +
  'podem estar desatualizados — nao cote preco a partir deles.';

return [{ json: { resposta: vende ? texto + SEPARADOR + AVISO : texto } }];
