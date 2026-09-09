// Prova a 56 em TRANSACAO ABORTADA contra producao. Nada e comitado.
const fs = require('fs');
const pg = require('pg');
const path = require('path');
const RAIZ = require('path').resolve(__dirname, '..');
const env = fs.readFileSync(RAIZ + '/.env.local', 'utf8');
const url = env.split(/\r?\n/).find((l) => l.startsWith('SUPABASE_DB_URL='))
  .slice('SUPABASE_DB_URL='.length).replace(/^["']|["']$/g, '');

const MIG = fs.readFileSync(RAIZ + '/supabase/migrations/20260909180000_56_portao_venda_afirmada.sql', 'utf8');
const RBK = fs.readFileSync(RAIZ + '/supabase/migrations/20260909180000_56_portao_venda_afirmada_rollback.sql', 'utf8');
// as migracoes trazem begin/commit proprios; dentro da transacao de teste eles atrapalham
const semTx = (s) => s.replace(/^\s*begin;\s*$/mi, '').replace(/^\s*commit;\s*$/mi, '');

let ok = 0, fail = 0;
const chk = (nome, cond, detalhe) => {
  if (cond) { ok++; console.log('  OK    ' + nome); }
  else { fail++; console.log('  FALHA ' + nome + (detalhe ? ' — ' + detalhe : '')); }
};

(async () => {
  const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();
  await c.query('begin');
  try {
    // ------------------------------------------------------------------
    console.log('\n-- 1. Rollback-primeiro: poe o banco no estado pre-56 --');
    await c.query(semTx(RBK));
    const semFn = await c.query(`select count(*)::int n from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
                                  where ns.nspname='public' and p.proname='api_n8n_estado_pedido'`);
    chk('depois do rollback a funcao NAO existe', semFn.rows[0].n === 0);

    // ------------------------------------------------------------------
    console.log('\n-- 2. A migracao aplica --');
    await c.query(semTx(MIG));
    const comFn = await c.query(`select count(*)::int n from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
                                  where ns.nspname='public' and p.proname='api_n8n_estado_pedido'`);
    chk('a funcao existe', comFn.rows[0].n === 1);
    const col = await c.query(`select count(*)::int n from information_schema.columns
                                where table_schema='public' and table_name='mensagens_log' and column_name='portao'`);
    chk('a coluna portao existe', col.rows[0].n === 1);

    // ------------------------------------------------------------------
    console.log('\n-- 3. ACL: revoke fez efeito e os DOIS roles tem execute --');
    const acl = await c.query(`select coalesce(array_to_string(p.proacl::text[], ' | '), '(nulo)') as acl
                                 from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
                                where ns.nspname='public' and p.proname='api_n8n_estado_pedido'`);
    const a = acl.rows[0].acl;
    chk('n8n_agent tem execute', /n8n_agent=X/.test(a), a);
    chk('service_role tem execute', /service_role=X/.test(a), a);
    chk('anon NAO tem', !/anon=X/.test(a), a);
    chk('authenticated NAO tem', !/authenticated=X/.test(a), a);
    chk('PUBLIC NAO tem', !/(^|\| )=X/.test(a), a);

    // o ACL de registrar_mensagem nao pode ter mudado (create or replace, sem drop)
    const aclReg = await c.query(`select array_to_string(p.proacl::text[], ' | ') as acl
                                    from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
                                   where ns.nspname='public' and p.proname='api_n8n_registrar_mensagem'`);
    chk('registrar_mensagem manteve n8n_agent', /n8n_agent=X/.test(aclReg.rows[0].acl), aclReg.rows[0].acl);
    const arid = await c.query(`select count(*)::int n from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
                                 where ns.nspname='public' and p.proname='api_n8n_registrar_mensagem'`);
    chk('registrar_mensagem tem UMA assinatura viva (sem ambiguidade)', arid.rows[0].n === 1, 'n=' + arid.rows[0].n);

    // ------------------------------------------------------------------
    console.log('\n-- 4. Chamar de verdade como n8n_agent --');
    const t = await c.query(`select id from public.tenants where slug='estudyou-sendbox'`);
    const tid = t.rows[0].id;
    await c.query('savepoint sp_role');
    await c.query('set local role n8n_agent');
    const r = await c.query(`select * from public.api_n8n_estado_pedido($1::uuid, 999999::bigint, 'vendas', 300)`, [tid]);
    chk('n8n_agent chama e recebe linha', r.rows.length === 1);
    chk('conversa sem pedido -> tem_pedido falso', r.rows[0].tem_pedido === false);
    chk('conversa sem pedido -> itens vazio', JSON.stringify(r.rows[0].itens) === '[]');
    const rb = await c.query(`select * from public.api_n8n_estado_pedido($1::uuid, 999999::bigint, 'basico', 300)`, [tid]);
    chk('perfil basico devolve vazio', rb.rows[0].tem_pedido === false && rb.rows[0].total_centavos === 0);
    await c.query('rollback to savepoint sp_role');

    // ------------------------------------------------------------------
    console.log('\n-- 5. Estado ARRANJADO: rascunho com item, escrita neste turno --');
    // arranja o proprio estado em vez de torcer para producao ter um
    const conv = 987654;
    const prod = await c.query(`select id, preco_centavos from public.produtos
                                 where tenant_id=$1 and deletado_em is null limit 1`, [tid]);
    const ped = await c.query(
      `insert into public.pedidos (tenant_id, conversation_id, status, total_centavos)
       values ($1,$2,'rascunho',0) returning id`, [tid, conv]);
    await c.query(
      `insert into public.pedido_itens (tenant_id, pedido_id, produto_id, nome_snapshot, preco_unit_centavos, quantidade)
       values ($1,$2,$3,'Item de teste do portao',1500,10)`, [tid, ped.rows[0].id, prod.rows[0].id]);

    let e = await c.query(`select * from public.api_n8n_estado_pedido($1::uuid,$2::bigint,'vendas',300)`, [tid, conv]);
    chk('tem_pedido verdadeiro', e.rows[0].tem_pedido === true);
    chk('total recalculado pelo trigger = 15000', e.rows[0].total_centavos === 15000, String(e.rows[0].total_centavos));
    chk('um item, em centavos', e.rows[0].itens.length === 1 && e.rows[0].itens[0].subtotal_centavos === 15000);
    chk('nome_snapshot preservado', e.rows[0].itens[0].nome === 'Item de teste do portao');
    chk('sem saida anterior -> escreveu_neste_turno verdadeiro', e.rows[0].escreveu_neste_turno === true);

    // agora registra uma saida DEPOIS da mutacao: o proximo turno nao escreveu
    await c.query(`select public.api_n8n_registrar_mensagem($1::uuid,$2::bigint,'saida','oi',0,0,'m',null,null,null::jsonb)`, [tid, conv]);
    e = await c.query(`select * from public.api_n8n_estado_pedido($1::uuid,$2::bigint,'vendas',300)`, [tid, conv]);
    chk('depois de uma saida -> escreveu_neste_turno FALSO', e.rows[0].escreveu_neste_turno === false);

    // e uma mutacao nova volta a marcar escrita.
    //
    // ARRANJO EXPLICITO DO TEMPO, e ele e obrigatorio: dentro de UMA transacao
    // `now()` fica congelado no inicio dela, entao `atualizado_em` e `criado_em`
    // saem IGUAIS e o `>` da funcao devolve falso. Isso e artefato do teste, nao
    // do produto — em producao cada turno e uma transacao. Recuar a saida no
    // tempo faz a comparacao medir o que ela mede de verdade.
    await c.query(`update public.mensagens_log set criado_em = now() - interval '10 min'
                    where tenant_id=$1 and conversation_id=$2 and direcao='saida'`, [tid, conv]);
    await c.query(`update public.pedido_itens set quantidade=11 where pedido_id=$1`, [ped.rows[0].id]);
    e = await c.query(`select * from public.api_n8n_estado_pedido($1::uuid,$2::bigint,'vendas',300)`, [tid, conv]);
    chk('mutacao de ITEM marca escrita neste turno', e.rows[0].escreveu_neste_turno === true);
    chk('total seguiu o item (11 x 1500)', e.rows[0].total_centavos === 16500, String(e.rows[0].total_centavos));

    // ------------------------------------------------------------------
    console.log('\n-- 5b. O TETO da janela, e o primeiro turno --');
    // Sem teto, a borda de baixo e a ultima saida — que pode estar a 18 DIAS
    // (maximo medido em `mensagens_log`). Uma mutacao antiga passaria por
    // "escreveu neste turno" e deixaria a fabricacao passar.
    // ARRANJAR UM PEDIDO ANTIGO **COM ITENS** NAO TEM CAMINHO NORMAL, e a
    // descoberta vale mais que o teste:
    //
    //   - por UPDATE nao da: `trg_pedidos_upd` e `trg_pedido_itens_upd` sao
    //     BEFORE UPDATE e chamam `set_atualizado_em`, entao qualquer tentativa
    //     de RECUAR `atualizado_em` e sobrescrita por `now()`, em silencio;
    //   - por INSERT com data explicita tambem nao: inserir o ITEM dispara
    //     `trg_pedido_itens_total` (AFTER INSERT) -> `pedidos_recalcula_total`
    //     -> `update public.pedidos` -> `trg_pedidos_upd` -> `now()`. O pai e
    //     recarimbado pelo filho.
    //
    // Medido: com as duas datas plantadas no insert, o item ficou em D-20 e o
    // pedido voltou para hoje.
    //
    // Isso e boa noticia em PRODUCAO — e justamente o que faz `escreveu_neste_
    // turno` enxergar escrita de item —, e no teste obriga a desligar o trigger.
    // `set local session_replication_role = replica` desliga trigger de usuario
    // so nesta transacao, sem DDL e sem lock de tabela (o `alter table ...
    // disable trigger` pegaria ACCESS EXCLUSIVE numa tabela de producao).
    const convVelho = 987657;
    const pedVelho = await c.query(
      `insert into public.pedidos (tenant_id, conversation_id, status, total_centavos, criado_em, atualizado_em)
       values ($1,$2,'rascunho',0, now() - interval '20 days', now() - interval '20 days') returning id`,
      [tid, convVelho]);
    await c.query(
      `insert into public.pedido_itens (tenant_id, pedido_id, produto_id, nome_snapshot, preco_unit_centavos, quantidade)
       values ($1,$2,$3,'Item velho',1500,10)`,
      [tid, pedVelho.rows[0].id, prod.rows[0].id]);
    await c.query(`set local session_replication_role = replica`);
    await c.query(`update public.pedidos set atualizado_em = now() - interval '20 days' where id=$1`, [pedVelho.rows[0].id]);
    await c.query(`update public.pedido_itens set atualizado_em = now() - interval '20 days' where pedido_id=$1`, [pedVelho.rows[0].id]);
    await c.query(`set local session_replication_role = origin`);
    // confirma que a mutacao ENTROU antes de acreditar no resultado
    const conf = await c.query(`select atualizado_em < now() - interval '19 days' as recuou from public.pedidos where id=$1`, [pedVelho.rows[0].id]);
    chk('o arranjo entrou: o pedido recuou no tempo', conf.rows[0].recuou === true);
    // e a saida anterior tambem e antiga: sem teto, a janela teria 30 dias
    await c.query(
      `insert into public.mensagens_log (tenant_id, conversation_id, direcao, conteudo, criado_em)
       values ($1,$2,'saida','antiga', now() - interval '30 days')`, [tid, convVelho]);
    e = await c.query(`select * from public.api_n8n_estado_pedido($1::uuid,$2::bigint,'vendas',300)`, [tid, convVelho]);
    chk('mutacao de 20 dias atras NAO conta como escrita do turno (teto de 300s)',
        e.rows[0].escreveu_neste_turno === false);
    chk('mas o pedido continua sendo referencia (cai no rascunho)', e.rows[0].tem_pedido === true);

    // Com teto largo, a MESMA mutacao volta a contar — prova que quem decidiu
    // foi o teto, e nao outra coisa que por acaso mudou junto.
    e = await c.query(`select * from public.api_n8n_estado_pedido($1::uuid,$2::bigint,'vendas',2592000)`, [tid, convVelho]);
    chk('com teto de 30 dias a mesma mutacao volta a contar (o teto e que decidiu)',
        e.rows[0].escreveu_neste_turno === true);

    // PRIMEIRO TURNO: sem saida nenhuma, so o teto limita.
    const convNovo = 987655;
    const pedNovo = await c.query(
      `insert into public.pedidos (tenant_id, conversation_id, status, total_centavos)
       values ($1,$2,'rascunho',0) returning id`, [tid, convNovo]);
    await c.query(
      `insert into public.pedido_itens (tenant_id, pedido_id, produto_id, nome_snapshot, preco_unit_centavos, quantidade)
       values ($1,$2,$3,'Item primeiro turno',500,2)`, [tid, pedNovo.rows[0].id, prod.rows[0].id]);
    e = await c.query(`select * from public.api_n8n_estado_pedido($1::uuid,$2::bigint,'vendas',300)`, [tid, convNovo]);
    chk('primeiro turno, pedido criado agora -> escreveu_neste_turno verdadeiro',
        e.rows[0].escreveu_neste_turno === true);
    // De novo por INSERT, pelo mesmo motivo do bloco acima: conversa NOVA (sem
    // nenhuma saida registrada) com um rascunho pendurado de dois dias atras.
    const convPendurado = 987658;
    const pedPend = await c.query(
      `insert into public.pedidos (tenant_id, conversation_id, status, total_centavos, criado_em, atualizado_em)
       values ($1,$2,'rascunho',0, now() - interval '2 days', now() - interval '2 days') returning id`,
      [tid, convPendurado]);
    await c.query(
      `insert into public.pedido_itens (tenant_id, pedido_id, produto_id, nome_snapshot, preco_unit_centavos, quantidade)
       values ($1,$2,$3,'Pendurado',500,2)`, [tid, pedPend.rows[0].id, prod.rows[0].id]);
    await c.query(`set local session_replication_role = replica`);
    await c.query(`update public.pedidos set atualizado_em = now() - interval '2 days' where id=$1`, [pedPend.rows[0].id]);
    await c.query(`update public.pedido_itens set atualizado_em = now() - interval '2 days' where pedido_id=$1`, [pedPend.rows[0].id]);
    await c.query(`set local session_replication_role = origin`);
    e = await c.query(`select * from public.api_n8n_estado_pedido($1::uuid,$2::bigint,'vendas',300)`, [tid, convPendurado]);
    chk('primeiro turno com rascunho VELHO -> NAO conta como escrita (furo do -infinity)',
        e.rows[0].escreveu_neste_turno === false);

    // ------------------------------------------------------------------
    console.log('\n-- 5c. Referencia: o pedido TOCADO no turno, nao so o rascunho --');
    const convF = 987656;
    const pedF = await c.query(
      `insert into public.pedidos (tenant_id, conversation_id, status, numero, total_centavos)
       values ($1,$2,'aguardando_pagamento',9911,0) returning id`, [tid, convF]);
    await c.query(
      `insert into public.pedido_itens (tenant_id, pedido_id, produto_id, nome_snapshot, preco_unit_centavos, quantidade)
       values ($1,$2,$3,'Pao de queijo',150,20)`, [tid, pedF.rows[0].id, prod.rows[0].id]);
    e = await c.query(`select * from public.api_n8n_estado_pedido($1::uuid,$2::bigint,'vendas',300)`, [tid, convF]);
    chk('pedido FECHADO tocado no turno vira a referencia', e.rows[0].tem_pedido === true);
    chk('e vem com o status certo', e.rows[0].pedido_status === 'aguardando_pagamento', e.rows[0].pedido_status);
    chk('e com o numero', e.rows[0].pedido_numero === 9911, String(e.rows[0].pedido_numero));
    chk('e com o total do banco (R$ 30,00)', e.rows[0].total_centavos === 3000, String(e.rows[0].total_centavos));
    chk('era exatamente o caso que "sempre o rascunho" perdia', e.rows[0].escreveu_neste_turno === true);

    // ------------------------------------------------------------------
    console.log('\n-- 6. O veredito viaja no componentes e vira coluna --');
    await c.query(`select public.api_n8n_registrar_mensagem($1::uuid,$2::bigint,'saida','texto',0,0,'m',null,'exec-portao-1',
                    $3::jsonb)`, [tid, conv, JSON.stringify({ chamadas: 1, portao: { veredito: 'barrado_regra_2', total_afirmado_centavos: 4250 } })]);
    const g = await c.query(`select portao from public.mensagens_log
                              where tenant_id=$1 and execucao_id='exec-portao-1' and direcao='saida'`, [tid]);
    chk('coluna portao preenchida a partir do componentes', g.rows[0].portao?.veredito === 'barrado_regra_2');
    e = await c.query(`select * from public.api_n8n_estado_pedido($1::uuid,$2::bigint,'vendas',300)`, [tid, conv]);
    chk('barrou_anterior verdadeiro depois de uma barrada', e.rows[0].barrou_anterior === true);

    await c.query(`select public.api_n8n_registrar_mensagem($1::uuid,$2::bigint,'saida','ok',0,0,'m',null,'exec-portao-2',
                    $3::jsonb)`, [tid, conv, JSON.stringify({ chamadas: 1, portao: { veredito: 'passou' } })]);
    e = await c.query(`select * from public.api_n8n_estado_pedido($1::uuid,$2::bigint,'vendas',300)`, [tid, conv]);
    chk('barrou_anterior FALSO depois de um passou', e.rows[0].barrou_anterior === false);

    // chave ausente / tipo errado nao levanta e nao preenche
    await c.query(`select public.api_n8n_registrar_mensagem($1::uuid,$2::bigint,'saida','x',0,0,'m',null,'exec-portao-3',
                    $3::jsonb)`, [tid, conv, JSON.stringify({ chamadas: 1, portao: 'nao sou objeto' })]);
    const g3 = await c.query(`select portao from public.mensagens_log where tenant_id=$1 and execucao_id='exec-portao-3'`, [tid]);
    chk('portao com tipo errado vira null, sem levantar', g3.rows[0].portao === null);

    // ------------------------------------------------------------------
    console.log('\n-- 7. Nao escreve: `stable` e sem expiracao --');
    const vol = await c.query(`select p.provolatile from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
                                where ns.nspname='public' and p.proname='api_n8n_estado_pedido'`);
    chk('funcao e stable (nao volatile)', vol.rows[0].provolatile === 's', vol.rows[0].provolatile);
    const src = await c.query(`select prosrc from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
                                where ns.nspname='public' and p.proname='api_n8n_estado_pedido'`);
    chk('corpo NAO chama expirar_pedidos_vencidos', !/expirar_pedidos_vencidos/.test(src.rows[0].prosrc));
    chk('corpo filtra tenant_id explicitamente (regra 6)', (src.rows[0].prosrc.match(/tenant_id\s*=\s*p_tenant_id/g) || []).length >= 4);

    // ------------------------------------------------------------------
    console.log('\n-- 9. A QUERY DO NO, executada contra a funcao real --');
    // ------------------------------------------------------------------
    // ESTA E A UNICA VERIFICACAO QUE EXERCITA O PAR DE VERDADE.
    //
    // O terceiro defeito da mesma familia (fonte muda, derivado nao acompanha):
    // o no `Estado do Pedido` pedia `tem_rascunho`, coluna que a migracao 56 nao
    // tem. Importado, o Postgres responderia `42703` e o no morreria — e ele
    // esta no CAMINHO UNICO, entre `Estima Tokens` e `Credencial (resposta)`.
    // Nao seria o portao ficar mudo: seria o AGENTE PARAR, para todo tenant.
    //
    // E nada pegava:
    //   - `n8n:sincronia` compara codigo com codigo, nunca SQL com assinatura;
    //   - `teste:portao-venda` MOCKA o estado, entao a query nem existe la;
    //   - este arquivo chamava `select * from`, que nunca exercita a lista de
    //     colunas que o no escreve.
    //
    // Comparar texto com texto tambem nao basta: uma comparacao pode estar
    // comparando errado. O que fecha e RODAR a string do no, verbatim, contra a
    // funcao que a migracao acabou de criar nesta transacao.
    {
      const wf = JSON.parse(fs.readFileSync(
        path.join(RAIZ, 'n8n', 'workflows', 'agente-principal.json'), 'utf8'));
      const noEstado = wf.nodes.find((n) => n.name === 'Estado do Pedido');
      chk('o no "Estado do Pedido" existe no workflow', Boolean(noEstado));

      if (noEstado) {
        const sql = noEstado.parameters.query;

        // 1. roda VERBATIM, com os mesmos tres parametros que o no manda
        let r;
        try {
          r = await c.query(sql, [tid, String(conv), 'vendas']);
          chk('a query do no EXECUTA contra a funcao da migracao 56', true);
        } catch (e) {
          chk('a query do no EXECUTA contra a funcao da migracao 56', false,
            `${e.code} ${e.message}`);
        }

        // 2. e devolve exatamente as colunas que o `aplica-portao.js` LE
        if (r) {
          const devolvidas = r.fields.map((f) => f.name);
          const corpo = fs.readFileSync(path.join(RAIZ, 'n8n', 'aplica-portao.js'), 'utf8');
          const lidas = [...new Set([...corpo.matchAll(/\bestado\.([a-z_]+)/g)].map((m) => m[1]))];

          // lista vazia e erro, nao "nada a conferir" — foi assim que o injetor
          // gravou um SELECT sem coluna nenhuma e a guarda dele aprovou
          chk('a extracao achou leituras `estado.X` no portao', lidas.length > 0, `${lidas.length}`);

          const faltando = lidas.filter((x) => !devolvidas.includes(x));
          chk('toda coluna que o portao LE vem na query do no', faltando.length === 0,
            faltando.length ? `faltam: ${faltando.join(', ')}` : '');

          const sobrando = devolvidas.filter((x) => !lidas.includes(x));
          chk('a query nao pede coluna que ninguem le', sobrando.length === 0,
            sobrando.length ? `sobram: ${sobrando.join(', ')}` : '');
        }
      }
    }

    // ------------------------------------------------------------------
    console.log('\n-- 9b. SABOTAGEM da query do no --');
    // ------------------------------------------------------------------
    // Reintroduz o nome proibido e exige que a execucao REPROVE com 42703. Sem
    // isto, o bloco acima poderia estar passando por qualquer motivo.
    {
      const wf = JSON.parse(fs.readFileSync(
        path.join(RAIZ, 'n8n', 'workflows', 'agente-principal.json'), 'utf8'));
      const sql = wf.nodes.find((n) => n.name === 'Estado do Pedido').parameters.query;
      const sabotado = sql.replace('tem_pedido', 'tem_rascunho');
      chk('a sabotagem MUTOU a query (senao o resultado abaixo nao vale nada)',
        sabotado !== sql, sabotado === sql ? 'a string nao mudou' : '');

      await c.query('savepoint sp_sab');
      let codigo = null;
      try {
        await c.query(sabotado, [tid, String(conv), 'vendas']);
      } catch (e) {
        codigo = e.code;
      }
      await c.query('rollback to savepoint sp_sab');
      chk('com `tem_rascunho` o Postgres responde 42703 (coluna inexistente)',
        codigo === '42703', `codigo=${codigo}`);
    }

    // ------------------------------------------------------------------
    console.log('\n-- 8. O rollback volta atras --');
    await c.query(semTx(RBK));
    const dep = await c.query(`select count(*)::int n from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
                                where ns.nspname='public' and p.proname='api_n8n_estado_pedido'`);
    chk('rollback dropou a funcao', dep.rows[0].n === 0);
    const colDep = await c.query(`select count(*)::int n from information_schema.columns
                                   where table_schema='public' and table_name='mensagens_log' and column_name='portao'`);
    chk('rollback MANTEM a coluna (deliberado)', colDep.rows[0].n === 1);
    const aclDep = await c.query(`select array_to_string(p.proacl::text[], ' | ') as acl
                                    from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
                                   where ns.nspname='public' and p.proname='api_n8n_registrar_mensagem'`);
    chk('rollback preservou grants de registrar_mensagem', /n8n_agent=X/.test(aclDep.rows[0].acl));

    // reexecutavel
    await c.query(semTx(RBK));
    chk('rollback e reexecutavel', true);
    await c.query(semTx(MIG));
    await c.query(semTx(MIG));
    chk('migracao e reexecutavel', true);
  } catch (err) {
    fail++;
    console.log('\n  EXCECAO: ' + err.message);
  } finally {
    await c.query('rollback');
    await c.end();
  }
  console.log(`\n  ${ok} passaram, ${fail} falharam`);
  process.exit(fail ? 1 : 0);
})();
