/**
 * Arranja o vinculo Chatwoot pre-migracao 54 para que ela possa ser REPLAYADA.
 *
 * ---------------------------------------------------------------------------
 * QUAL DOS DOIS ESTA CERTO: A PRODUCAO
 *
 * A migracao 54 tem um backfill com valores cravados e um `raise` que confere o
 * proprio resultado:
 *
 *   update public.tenants set chatwoot_inbox_id = 189
 *    where slug = 'estudyou-sendbox' and chatwoot_account_id = 1;
 *   ...
 *   if v_sendbox is distinct from 189 then raise exception 'backfill: ...';
 *
 * Em producao o `estudyou-sendbox` esta hoje em **conta 57, caixa 282**,
 * reconectado pelo painel em 2026-09-09 09:22. Isso e operacao NORMAL: religar
 * um tenant a outra conta do Chatwoot e exatamente para o que a tela existe.
 *
 * Entao o backfill nao pega nada, `v_sendbox` sai nulo e a migracao aborta. Os
 * dois testes que a replayam (`teste:roteamento-caixa` e
 * `teste:desconectar-chatwoot`) ficaram vermelhos em 09/09 -- e vermelhos
 * porque o sistema funcionou.
 *
 * **Quem esta velho e a migracao, nao a producao.** O arquivo da 54 encodifica
 * o mundo de 28/08 e nao pode ser reescrito: ele ja rodou, e o texto tem de
 * continuar sendo o que rodou. Quem se adapta e o teste, e a adaptacao e a
 * mesma que o `pedidos-vivos-55.mjs` faz: **o teste ARRANJA o estado que vai
 * medir, em vez de torcer para producao ainda te-lo.**
 *
 * Nao e "vermelho herdado" e nao e "pre-existente": e um teste que afirmava
 * estado do mundo, que e o defeito nº 8 e nº 9 da contagem do CLAUDE.md, agora
 * pela porta do backfill de migracao.
 *
 * ---------------------------------------------------------------------------
 * O QUE ELE FAZ
 *
 * Dentro da transacao ja aberta pelo teste (que termina em rollback), devolve
 * os tenants ao vinculo que a 54 espera encontrar. Nada e comitado.
 *
 * ELE ESTOURA SE NAO RESOLVER. Helper que nao muta nada e devolve sucesso e a
 * mesma armadilha da sabotagem que nao mutou -- o teste ficaria verde por nao
 * ter medido nada.
 */

// O mundo de 28/08, que e o que o backfill da 54 procura. A caixa nao entra
// aqui: o rollback da 54 DROPA `chatwoot_inbox_id`, entao no ponto em que este
// helper roda a coluna nem existe. So a conta importa.
export const CONTAS_PRE_54 = {
  'estudyou-sendbox': 1,
  emporio: 59,
};

/**
 * @param {import('pg').Client} c  conexao com a transacao JA aberta
 * @returns {Promise<Array<{slug: string, de: number|null, para: number}>>}
 *          o que foi mexido, para o teste poder imprimir
 */
export async function arranjarContasPre54(c) {
  const mexidos = [];

  for (const [slug, conta] of Object.entries(CONTAS_PRE_54)) {
    const antes = await c.query(
      'select chatwoot_account_id::int as conta from public.tenants where slug = $1',
      [slug],
    );
    if (antes.rowCount === 0) {
      throw new Error(`caixa-54: tenant "${slug}" nao existe — o arranjo nao tem o que fazer`);
    }
    const de = antes.rows[0].conta;
    if (de === conta) continue;

    const upd = await c.query(
      'update public.tenants set chatwoot_account_id = $2 where slug = $1',
      [slug, conta],
    );
    if (upd.rowCount !== 1) {
      throw new Error(`caixa-54: o update de "${slug}" mexeu em ${upd.rowCount} linhas, esperava 1`);
    }

    // CONFIRMA QUE A MUTACAO ENTROU. Sem reler, um trigger, uma policy ou um
    // `where` que nao casa deixariam o helper reportando sucesso sem ter feito
    // nada — e o teste seguinte ficaria verde por vacuidade.
    const depois = await c.query(
      'select chatwoot_account_id::int as conta from public.tenants where slug = $1',
      [slug],
    );
    if (depois.rows[0].conta !== conta) {
      throw new Error(
        `caixa-54: "${slug}" continua em ${depois.rows[0].conta} depois do update, esperava ${conta}`,
      );
    }
    mexidos.push({ slug, de, para: conta });
  }

  return mexidos;
}
