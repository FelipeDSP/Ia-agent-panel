/**
 * Neutraliza, DENTRO da transacao do teste, o que impede o REPLAY do rollback
 * da migracao 61 — a mesma familia de `pedidos-vivos-55.mjs`.
 *
 * O rollback da 61 aborta de proposito em dois casos, e os dois passaram a
 * existir em producao em 16/09/2026, no dia em que o pagamento funcionou de
 * verdade no sendbox:
 *   1. cobranca com `pago_em` (ou `fora_do_prazo_em`): dropar a tabela apagaria
 *      a prova de que o dinheiro entrou;
 *   2. tenant com a tool `pagamento` em `tenant_tools`: dropar o catalogo
 *      descontrataria por efeito colateral.
 *
 * Quanto mais o pagamento funciona, menos o rollback dele roda — e o teste que
 * comeca pelo rollback fica refem de producao. O corolario do CLAUDE.md: o
 * teste ARRANJA o estado pre-migracao em vez de torcer para ele existir. Aqui:
 * tira o carimbo de pago das cobrancas e a contratacao de `pagamento`, so
 * nesta transacao (nada e comitado; a cobranca do pedido nº 4 do sendbox
 * continua paga quando o teste termina em `rollback`).
 *
 * Reconfere depois de mexer e ESTOURA se ainda houver o que abortaria: helper
 * que nao muta e devolve sucesso e a "sabotagem que nao mutou nada".
 */
export async function neutralizarCobrancasPagas(c) {
  const antes = await contar(c);
  if (antes.pagas > 0) {
    await c.query(`update public.pedido_cobrancas set pago_em = null, fora_do_prazo_em = null where pago_em is not null or fora_do_prazo_em is not null`);
  }
  if (antes.contratadas > 0) {
    await c.query(`delete from public.tenant_tools where tool_nome = 'pagamento'`);
  }
  const depois = await contar(c);
  if (depois.pagas > 0 || depois.contratadas > 0) {
    throw new Error(`neutralizarCobrancasPagas NAO resolveu: pagas=${depois.pagas} contratadas=${depois.contratadas}`);
  }
  return { antes, depois };
}

async function contar(c) {
  const tabela = (await c.query(`select to_regclass('public.pedido_cobrancas') r`)).rows[0].r;
  const pagas = tabela
    ? Number((await c.query(`select count(*)::int n from public.pedido_cobrancas where pago_em is not null or fora_do_prazo_em is not null`)).rows[0].n)
    : 0;
  const contratadas = Number((await c.query(`select count(*)::int n from public.tenant_tools where tool_nome = 'pagamento'`)).rows[0].n);
  return { pagas, contratadas };
}
