/**
 * Descontratar esconde superfície. NÃO apaga dado.
 *
 * A PROPRIEDADE: descontratar uma tool não muda a contagem de nenhuma tabela que
 * ela alimenta. A tela some, o dado fica, e recontratar devolve tudo.
 *
 * POR QUE MEDIR EM VEZ DE AFIRMAR. `definirContratacao` só vira um booleano —
 * dá para ler o código e acreditar. O que a leitura NÃO cobre é o banco: um
 * trigger, uma FK com ON DELETE CASCADE ou uma policy que some com a linha
 * fariam o catálogo evaporar sem nenhuma linha de TypeScript envolvida. Se
 * alguém descontratar por engano e os produtos sumirem, o cliente perde trabalho
 * de cadastro que ninguém consegue devolver.
 *
 * PROPRIEDADE, NÃO ESTADO DO MUNDO. Não afirma "o restaurante-teste tem 13
 * produtos" — isso fica falso no dia em que ele cadastrar o décimo quarto, que é
 * uma operação normal. Afirma que a contagem ANTES é igual à contagem DEPOIS,
 * qualquer que seja ela.
 *
 * RODA EM TRANSAÇÃO ABORTADA. Descontrata de verdade, mede, e dá ROLLBACK:
 * produção não muda. Mesmo padrão dos testes de migração.
 *
 * Uso: npm run teste:descontratar
 */

import { Client } from 'pg';

const conexao = process.env.SUPABASE_DB_URL;
if (!conexao) {
  console.error('SUPABASE_DB_URL ausente. Rode com --env-file=.env.local');
  process.exit(1);
}

// Tabelas que a tool alimenta. Cresce quando uma tool nova trouxer tabela nova.
const SUPERFICIE_DE_DADO = {
  vendas: ['produtos', 'pedidos', 'pedido_itens'],
  foto_produto: ['fotos_enviadas'],
};

let passou = 0;
let falhou = 0;

function ok(condicao, descricao) {
  if (condicao) {
    passou++;
    console.log(`  OK    ${descricao}`);
  } else {
    falhou++;
    console.log(`  FALHA ${descricao}`);
  }
}

const c = new Client({ connectionString: conexao, ssl: { rejectUnauthorized: false } });
await c.connect();
await c.query('begin');

// Descontratar é operação DA AGÊNCIA — o trigger `tenant_tools_guard_colunas`
// recusa `contratado` para qualquer outro papel, e recusaria esta conexão, que
// chega sem JWT. Assumir o papel é o que faz o teste exercitar a operação real
// em vez de uma que ninguém executa.
//
// `set local` morre no rollback junto com o resto. E note que NÃO desligamos
// trigger nem `session_replication_role`: se existisse um cascade apagando
// produtos, o teste precisa vê-lo acontecer, não contorná-lo.
await c.query(`set local request.jwt.claims = '{"app_metadata":{"papel":"super_admin"}}'`);

try {
  const { rows: tenants } = await c.query(
    `select id, slug from public.tenants where deletado_em is null order by slug`,
  );

  for (const [tool, tabelas] of Object.entries(SUPERFICIE_DE_DADO)) {
    console.log(`\n=== ${tool} ===\n`);

    let exercitou = 0;

    for (const t of tenants) {
      const { rows: temLinha } = await c.query(
        `select contratado from public.tenant_tools where tenant_id = $1 and tool_nome = $2`,
        [t.id, tool],
      );
      if (temLinha.length === 0) continue;

      const contar = async () => {
        const n = {};
        for (const tabela of tabelas) {
          const { rows } = await c.query(
            `select count(*)::int as n from public.${tabela} where tenant_id = $1`,
            [t.id],
          );
          n[tabela] = rows[0].n;
        }
        return n;
      };

      // A PRECONDIÇÃO É HAVER DADO, não haver contratação.
      //
      // A primeira versão exigia `contratado = true` e, no dia em que o Felipe
      // descontratou vendas do restaurante-teste para testar a regra, o teste
      // pulou TODOS os tenants e imprimiu verde. Precondição que some junto com
      // o que se quer testar é teste que não consegue falhar.
      //
      // Contagem zero também não exercita nada: não há dado para preservar.
      const antes = await contar();
      if (Object.values(antes).every((n) => n === 0)) continue;
      exercitou++;

      // Parte do estado atual, seja ele qual for: contrata, mede, descontrata,
      // mede. Funciona com a tool contratada ou não no início.
      await c.query(
        `update public.tenant_tools set contratado = true
          where tenant_id = $1 and tool_nome = $2`,
        [t.id, tool],
      );
      await c.query(
        `update public.tenant_tools set contratado = false
          where tenant_id = $1 and tool_nome = $2`,
        [t.id, tool],
      );
      const depois = await contar();

      for (const tabela of tabelas) {
        ok(
          antes[tabela] === depois[tabela],
          `${t.slug}: ${tabela} — ${antes[tabela]} antes, ${depois[tabela]} depois de descontratar`,
        );
      }

      // Recontratar devolve o estado: o `contratado` volta e nada mais mudou.
      await c.query(
        `update public.tenant_tools set contratado = true
          where tenant_id = $1 and tool_nome = $2`,
        [t.id, tool],
      );
      const revertido = await contar();
      for (const tabela of tabelas) {
        ok(
          antes[tabela] === revertido[tabela],
          `${t.slug}: ${tabela} — recontratar mantém ${revertido[tabela]}`,
        );
      }
    }

    // AVISO e não falha. "Nenhum tenant tem produto cadastrado" é estado do
    // mundo legítimo — catálogo vazio acontece. Falhar aqui treinaria todo mundo
    // a ignorar vermelho. Mas passar em silêncio esconderia que a propriedade
    // não foi exercitada, que foi exatamente o que aconteceu na primeira versão.
    if (exercitou === 0) {
      console.log(
        `  AVISO nenhum tenant tem dado em ${tabelas.join('/')} — a propriedade não foi exercitada`,
      );
    }
  }

  // Sabotagem embutida: se alguém criar uma FK em cascata a partir de
  // tenant_tools, ela apareceria aqui. A checagem explícita não custa nada e
  // diz POR QUE, em vez de só mostrar contagem diferente.
  console.log('\n=== nenhuma FK apaga dado ao mexer em tenant_tools ===\n');
  const { rows: fks } = await c.query(`
    select tc.table_name, rc.delete_rule
      from information_schema.table_constraints tc
      join information_schema.referential_constraints rc
        on rc.constraint_name = tc.constraint_name
      join information_schema.constraint_column_usage ccu
        on ccu.constraint_name = tc.constraint_name
     where tc.constraint_type = 'FOREIGN KEY'
       and ccu.table_name = 'tenant_tools'
  `);
  for (const fk of fks) {
    ok(
      fk.delete_rule !== 'CASCADE',
      `${fk.table_name} -> tenant_tools: ON DELETE ${fk.delete_rule}`,
    );
  }
  ok(true, `FKs apontando para tenant_tools: ${fks.length}`);
} finally {
  await c.query('rollback');
  await c.end();
}

console.log('\n' + '-'.repeat(60));
console.log(`  ${passou} passaram, ${falhou} falharam`);
console.log('  (transação abortada — produção não mudou)\n');
process.exitCode = falhou > 0 ? 1 : 0;
