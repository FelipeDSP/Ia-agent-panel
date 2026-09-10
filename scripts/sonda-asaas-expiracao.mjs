#!/usr/bin/env node
/**
 * SONDA — o que o Asaas faz com um link de pagamento fora do prazo.
 *
 * ---------------------------------------------------------------------------
 * POR QUE ELA EXISTE: A DOCUMENTAÇÃO NÃO RESPONDE
 *
 * Foram lidas quatro páginas em 10/09/2026 — criar, atualizar e remover link de
 * pagamentos, mais o guia — e NENHUMA descreve o que acontece quando alguém
 * tenta pagar um link já vencido (`endDate` passado) ou desativado
 * (`active=false`). O enunciado desta fase foi explícito: *"Se a documentação
 * não disser com clareza, teste no sandbox — não assuma."*
 *
 * O que a documentação DIZ, e já mudou o desenho da migração 61:
 *
 *   - `endDate` é uma DATA, não data-hora (o exemplo da referência é
 *     "2024-09-05"). Uma janela de 30 minutos NÃO cabe nesse campo;
 *   - existe `PUT /v3/paymentLinks/{id}` com `active`, e existe
 *     `DELETE /v3/paymentLinks/{id}` (removido pode ser restaurado);
 *   - sandbox é `https://api-sandbox.asaas.com`, header `access_token`.
 *
 * ---------------------------------------------------------------------------
 * ELA NÃO RODA NA SUÍTE, E NÃO DEVE. Fala com um serviço externo, cria objeto
 * lá, e depende de credencial que não existe neste repositório. `npm run teste`
 * varre o prefixo `teste:`; esta é `sonda:`, de propósito.
 *
 * ---------------------------------------------------------------------------
 * O QUE FAZER COM O RESULTADO
 *
 * A migração 61 já trata o caso como POSSÍVEL — é o caminho `fora_do_prazo`,
 * que registra a divergência, NÃO marca `pago` e NÃO reabre o pedido. Esta
 * sonda decide uma coisa só, e é uma decisão de produto:
 *
 *   se o link EXPIRA sozinho de forma confiável -> `fora_do_prazo` vira caso
 *     raro de corrida (o cliente pagou no segundo 29:58) e o alinhamento fino
 *     por `active=false` é opcional;
 *   se o link NÃO expira -> `fora_do_prazo` é o caminho NORMAL de todo cliente
 *     que demora, e desativar o link ao fim da nossa janela deixa de ser
 *     opcional. Aí é trabalho próprio: quem dispara, quando, e o que responder.
 *
 * Escreva o que ela medir em `docs/ENTREGA-PAGAMENTO-ASAAS-SANDBOX.md` §6.
 * Medição não escrita vira memória, e memória vira suposição.
 *
 * ---------------------------------------------------------------------------
 * Uso:
 *   ASAAS_SANDBOX_KEY='$aact_...' node scripts/sonda-asaas-expiracao.mjs
 *
 * A chave vem do AMBIENTE e não do banco: rodar isto não deve exigir tenant
 * configurado, e uma chave de sandbox em variável de ambiente de uma máquina de
 * desenvolvimento não é a mesma coisa que uma chave de produção no repo.
 * NUNCA passe chave de produção aqui — o script recusa se a URL não for a de
 * sandbox.
 */
const BASE = 'https://api-sandbox.asaas.com';
const KEY = process.env.ASAAS_SANDBOX_KEY;

if (!KEY) {
  console.error(`
FALTA A CREDENCIAL.

  ASAAS_SANDBOX_KEY='$aact_...' node scripts/sonda-asaas-expiracao.mjs

Não há chave do Asaas neste repositório nem em .env.local — conferido em
10/09/2026. Por isso a pergunta "o link expira?" continua EM ABERTO na
migração 61, e está escrita lá como aberta em vez de assumida.
`);
  process.exit(2);
}
if (!/^\$?aact_/.test(KEY)) {
  console.error('ABORTADO: isso não tem forma de chave do Asaas (`$aact_...`).');
  process.exit(2);
}

const req = async (metodo, caminho, corpo) => {
  const r = await fetch(BASE + caminho, {
    method: metodo,
    headers: { access_token: KEY, 'Content-Type': 'application/json' },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  const txt = await r.text();
  let json = null;
  try { json = JSON.parse(txt); } catch { /* resposta não-JSON é dado também */ }
  return { status: r.status, json, txt };
};

const mostra = (rot, r) => {
  console.log(`\n--- ${rot} -> HTTP ${r.status}`);
  console.log(JSON.stringify(r.json ?? r.txt, null, 2).slice(0, 1200));
};

console.log('== Sonda: link de pagamento fora do prazo (SANDBOX) ==');

// 1. ontem, para nascer já vencido — é o caso que interessa.
const ontem = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
const criado = await req('POST', '/v3/paymentLinks', {
  name: 'Sonda de expiracao (descartavel)',
  description: 'Objeto de teste criado por scripts/sonda-asaas-expiracao.mjs',
  billingType: 'PIX',
  chargeType: 'DETACHED',
  value: 1.0,
  endDate: ontem,
  notificationEnabled: false,
});
mostra(`criar link com endDate=${ontem} (ontem)`, criado);

const id = criado.json?.id;
if (!id) {
  console.error('\nNão consegui criar o link — nada a sondar. A resposta acima é o dado.');
  process.exit(1);
}

// 2. como ele volta na leitura: `active` continua true? há campo de status?
mostra('ler o link recém-criado', await req('GET', `/v3/paymentLinks/${id}`));

// 3. A PERGUNTA CENTRAL: a página pública ainda aceita pagamento?
//    Ela não é API — é a URL que o cliente abre. O que interessa é o STATUS e
//    se o corpo fala em vencido/indisponível.
const publico = criado.json?.url;
if (publico) {
  try {
    const r = await fetch(publico, { redirect: 'follow' });
    const corpo = await r.text();
    console.log(`\n--- abrir a URL pública -> HTTP ${r.status} (${corpo.length} bytes)`);
    const pistas = ['expirad', 'vencid', 'indisponív', 'indisponiv', 'encerrad', 'inativ', 'não está', 'nao esta'];
    const achadas = pistas.filter((p) => corpo.toLowerCase().includes(p));
    console.log(`    pistas de expiração no HTML: ${achadas.length ? achadas.join(', ') : 'NENHUMA'}`);
    console.log('    ^ NENHUMA + HTTP 200 significa que a página provavelmente aceita pagamento.');
    console.log('      Confirme ABRINDO no navegador antes de concluir: HTML é indício, não prova.');
  } catch (e) {
    console.log(`\n--- abrir a URL pública -> falhou: ${e.message}`);
  }
}

// 4. e com `active=false`, muda alguma coisa?
mostra('desativar (active=false)', await req('PUT', `/v3/paymentLinks/${id}`, { active: false }));
if (publico) {
  const r = await fetch(publico, { redirect: 'follow' });
  const corpo = await r.text();
  console.log(`\n--- abrir a URL pública DEPOIS de desativar -> HTTP ${r.status} (${corpo.length} bytes)`);
}

// 5. limpeza: o objeto foi criado por esta sonda e não deve ficar.
mostra('remover o link da sonda', await req('DELETE', `/v3/paymentLinks/${id}`));

console.log(`
============================================================
ESCREVA O RESULTADO em docs/ENTREGA-PAGAMENTO-ASAAS-SANDBOX.md §6.

As duas perguntas que ele responde:
  1. link com endDate no passado ainda aceita pagamento?
  2. active=false muda isso?

E a decisão que sai daí está na §6 daquele documento — se a resposta de (1)
for "aceita", desativar o link ao fim da nossa janela deixa de ser opcional.
============================================================`);
