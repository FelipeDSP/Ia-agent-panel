/**
 * Neutraliza os pedidos vivos que impedem o REPLAY do rollback da migracao 55.
 *
 * ---------------------------------------------------------------------------
 * POR QUE EXISTE
 *
 * O CLAUDE.md manda todo teste de migracao comecar pelo rollback da propria
 * migracao. Nao e zelo: e a unica forma de o teste NAO afirmar o calendario --
 * o rollback e idempotente e poe o banco no estado pre-migracao tendo ela sido
 * aplicada ou nao.
 *
 * A 55 e a primeira migracao para a qual essa regra deixou de valer, e nao por
 * defeito dela nem dos testes. Ela AMPLIOU o permitido: uma conversa com um
 * carrinho E uma venda fechada e operacao NORMAL desde 31/08, e o indice antigo
 * que o rollback recria proibe exatamente isso. O rollback entao aborta -- de
 * proposito, com mensagem propria -- e os tres testes que o replayam passam a
 * ser refens do estado de PRODUCAO.
 *
 * Aconteceu em 2026-09-08: um teste de venda no `estudyou-sendbox` deixou a
 * conversa 1864 com o pedido nº 2 (`aguardando_pagamento`) e um rascunho novo,
 * e `teste:acl-secdef`, `teste:migracao-pedido-novo` e `teste:migracao-vendas`
 * ficaram vermelhos sem defeito nenhum -- vermelhos porque o sistema
 * funcionou, que e a forma mais rapida de todo mundo parar de olhar a suite.
 *
 * ---------------------------------------------------------------------------
 * O QUE ELE FAZ, E O QUE ELE NAO E
 *
 * Cancela, DENTRO da transacao ja aberta pelo teste, os pedidos vivos
 * excedentes: mantem o mais ANTIGO de cada conversa (a venda) e cancela os
 * demais (o carrinho) -- que e literalmente a saida que o cabecalho do rollback
 * sugere para o caso. Nada e comitado; o teste termina em `rollback` e a
 * conversa 1864 segue intacta, o que importa porque ela e a evidencia da 2.4 da
 * PENDENCIA-VENDA-AFIRMADA-SEM-TOOL.md E a unica prova de que a 55 funciona.
 *
 * NAO e "limpar o banco para o teste passar". E ARRANJAR o estado que se vai
 * medir, que e o corolario do CLAUDE.md depois do oitavo caso de sabotagem:
 * se a assercao depende de algo que uma pessoa muda pela interface, ou o teste
 * arranja aquele algo, ou esta contando com sorte. Vender duas vezes na mesma
 * conversa e exatamente isso.
 *
 * ---------------------------------------------------------------------------
 * A EXIGENCIA QUE ELE FAZ DE SI MESMO
 *
 * `neutralizar` reconfere depois de mexer e ESTOURA se ainda houver conflito.
 * Sem isso um helper que nao mutasse nada -- por filtro errado, por outra
 * definicao de "vivo" -- devolveria sucesso e o teste seguinte morreria longe
 * daqui, com a mensagem do rollback e nao com a causa. Foi o modo de falha
 * "sabotagem que nao mutou nada" do CLAUDE.md, e ele vale para helper tanto
 * quanto para teste.
 */

/** A MESMA consulta do bloco 0 do rollback da 55. Se ela mudar la, muda aqui. */
const SQL_CONFLITOS = `
  select p.tenant_id, p.conversation_id, count(*)::int as n
    from public.pedidos p
   where p.status in ('rascunho', 'aguardando_pagamento')
     and p.deletado_em is null
   group by p.tenant_id, p.conversation_id
  having count(*) > 1
   order by 1, 2`;

/** Conversas que hoje tem mais de um pedido vivo. Leitura pura. */
export async function conflitos55(c) {
  const { rows } = await c.query(SQL_CONFLITOS);
  return rows;
}

/**
 * Deixa no maximo UM pedido vivo por conversa, cancelando os excedentes.
 * Precisa ser chamado com uma transacao ja aberta -- quem chama e responsavel
 * pelo `rollback`.
 *
 * Devolve `{ conversas, cancelados }`. `conversas: 0` e resultado legitimo:
 * significa que producao ja estava com no maximo um pedido vivo por conversa.
 */
export async function neutralizar(c) {
  const antes = await conflitos55(c);
  if (antes.length === 0) return { conversas: 0, cancelados: 0 };

  /*
   * A ORDEM NAO PODE SER `criado_em`, e isso custou um falso verde.
   *
   * `pedidos.criado_em` tem default `now()`, e `now()` e CONSTANTE dentro da
   * transacao -- so `clock_timestamp()` anda. Os dois pedidos que o bloco 8c
   * arranja nascem na MESMA transacao, entao tem `criado_em` identico, e
   * `order by criado_em, id` desempatava por `gen_random_uuid()`: qual pedido
   * sobrevivia era CARA OU COROA a cada execucao.
   *
   * Medido em 2026-09-08: a execucao solta passou e a mesma execucao sob
   * `npm run guarda` reprovou com "sobrou rascunho" -- mesmo codigo, mesma
   * transacao, resultado diferente. Uma assercao que depende de sorte fica
   * verde o suficiente para ninguem olhar.
   *
   * A ordem certa nao e temporal, e SEMANTICA: preserva-se a VENDA
   * (`aguardando_pagamento`) e cancela-se o CARRINHO (`rascunho`), que e
   * exatamente a saida que o cabecalho do rollback da 55 sugere. `criado_em` e
   * `id` ficam so como desempate estavel para o caso improvavel de duas vendas
   * vivas na mesma conversa.
   */
  const { rowCount } = await c.query(`
    update public.pedidos p
       set status = 'cancelado'
      from (
        select id,
               row_number() over (
                 partition by tenant_id, conversation_id
                 order by case when status = 'aguardando_pagamento' then 0 else 1 end,
                          criado_em, id) as pos
          from public.pedidos
         where status in ('rascunho', 'aguardando_pagamento')
           and deletado_em is null
      ) v
     where v.id = p.id and v.pos > 1`);

  const depois = await conflitos55(c);
  if (depois.length > 0) {
    throw new Error(
      `neutralizar() nao resolveu: ${depois.length} conversa(s) ainda com mais de `
      + `um pedido vivo depois de cancelar ${rowCount}. `
      + `Primeira: tenant ${depois[0].tenant_id} / conversa ${depois[0].conversation_id} `
      + `(${depois[0].n} vivos). O filtro daqui divergiu do bloco 0 do rollback da 55.`,
    );
  }
  return { conversas: antes.length, cancelados: rowCount };
}
