/**
 * Tenants que o próprio teste cria e destrói.
 *
 * POR QUE EXISTE. Os cinco testes de isolamento resolviam três tenants de SEED
 * por slug (`restaurante-teste`, `sandbox-de-testes`, `clinica-teste`). Em
 * 13/08/2026 duas dessas linhas foram soft-deletadas pelo painel — operação
 * legítima, sem relação com testes — e a suíte de isolamento ficou quatro dias
 * cega, na semana em que três clientes reais entraram. Pior: dos seis testes
 * acoplados, só um reclamou; os outros liam a linha soft-deletada e seguiam
 * verdes "testando" isolamento entre tenants que a aplicação considera
 * excluídos.
 *
 * O critério de aceitação, escrito em `docs/PENDENCIA-SEED-DOS-TESTES.md`:
 * **apagar seed nenhum consegue deixá-los verdes.** Não basta reprovar quando o
 * seed falta — o alvo é não ter seed para faltar.
 *
 * POR QUE CRIAR E LIMPAR, e não transação abortada. `descontratar-preserva-dado`
 * envolve tudo num `begin` que nunca comita, e é o padrão mais forte quando tudo
 * passa por UMA conexão. Não serve aqui: estes testes autenticam de verdade por
 * HTTP, cada login é outra conexão, e outra conexão não enxerga transação não
 * comitada. É a distinção que trava a reescrita na metade se for ignorada.
 *
 * SEGURANÇA DA REMOÇÃO. As 13 FKs para `tenants` são `ON DELETE CASCADE`
 * (verificado), então um id errado aqui apaga catálogo e base de conhecimento de
 * um cliente sem soft delete e sem volta. Por isso todo delete leva DUAS
 * condições: o id capturado E o prefixo de slug. Uma sozinha não basta.
 */

/** Vetor constante de 1536 dimensões — o formato que `kb_documentos` exige. */
const EMBEDDING = `[${Array(1536).fill(0.01).join(',')}]`;

const PREFIXO = 'zz-efem';

/**
 * Cria `quantidade` tenants efêmeros.
 *
 * `marca` entra no slug para dizer QUAL teste deixou a sobra, se algum dia
 * sobrar. `sufixo` é único por execução, para duas rodadas simultâneas não
 * colidirem — colisão por nome fixo é a mesma aposta em improbabilidade que
 * estes testes existem para eliminar.
 */
export async function criarTenantsEfemeros(admin, { marca, quantidade = 3, sufixo }) {
  if (!marca) throw new Error('criarTenantsEfemeros: informe a marca do teste');
  const id = sufixo ?? Math.random().toString(16).slice(2, 10);

  const linhas = Array.from({ length: quantidade }, (_, i) => ({
    slug: `${PREFIXO}-${marca}-${id}-${i}`,
    nome: `efêmero ${marca} ${id} #${i}`,
  }));

  const { data, error } = await admin.from('tenants').insert(linhas).select('id, slug, nome');
  if (error) throw new Error(`criar tenants efêmeros: ${error.message}`);
  if ((data ?? []).length !== quantidade) {
    throw new Error(`esperava ${quantidade} tenants efêmeros, vieram ${(data ?? []).length}`);
  }

  // A ordem do `insert ... returning` não é garantida; reordena pelo slug para
  // que A/B/C sejam estáveis entre execuções.
  return data.sort((x, y) => x.slug.localeCompare(y.slug));
}

/**
 * Remove os tenants criados. Chamar SEMPRE em `finally` — inclusive quando o
 * teste falha, que é justamente quando a sobra acontece.
 *
 * Devolve a lista de slugs que NÃO saíram, para o chamador poder gritar. Não
 * lança: um erro aqui mascararia a falha real do teste.
 */
export async function removerTenantsEfemeros(admin, tenants) {
  const sobraram = [];
  for (const t of tenants ?? []) {
    if (!t?.id) continue;
    const { data, error } = await admin
      .from('tenants')
      .delete()
      .eq('id', t.id)
      .like('slug', `${PREFIXO}-%`) // segunda condição: ver nota sobre CASCADE
      .select('id');
    if (error || (data ?? []).length !== 1) sobraram.push(t.slug);
  }
  return sobraram;
}

/**
 * Dá conteúdo ao tenant para que "não vejo nada do outro" signifique alguma
 * coisa.
 *
 * ANTI-VACUIDADE, e não conveniência. A asserção "o tenant A não alcança os
 * documentos de B" é verdadeira por vacuidade quando B não tem documento
 * nenhum — passa com a RLS ligada e passa com ela desligada. O teste antigo
 * escapava disso por acidente, porque mirava a Acqua, que tem 12 documentos de
 * verdade; e nunca conferia que ela tinha. No dia em que a Acqua fosse limpa, a
 * asserção viraria decoração sem ninguém notar.
 */
export async function semearConteudo(
  admin,
  tenantId,
  { docs = 1, conversas = 1, credencial = false, tools = [] } = {},
) {
  if (tools.length) {
    // Necessário para as asserções de tenant_tools: "UPDATE na linha do outro
    // tenant não afeta nada" é verdade por vacuidade se o outro não TEM a linha.
    // Hoje passava por acidente — os tenants de seed tinham `transferir_humano`
    // contratado, e ninguém conferia.
    const { error } = await admin
      .from('tenant_tools')
      .insert(tools.map((tool_nome) => ({ tenant_id: tenantId, tool_nome, ativo: true, contratado: true })));
    if (error) throw new Error(`semear tenant_tools: ${error.message}`);
  }

  if (docs > 0) {
    const linhas = Array.from({ length: docs }, (_, i) => ({
      tenant_id: tenantId,
      text: `documento efêmero ${i} — conteúdo que outro tenant não pode ler`,
      embedding: EMBEDDING,
      metadata: { tenant_id: tenantId, origem: 'efemero' },
    }));
    const { error } = await admin.from('kb_documentos').insert(linhas);
    if (error) throw new Error(`semear kb_documentos: ${error.message}`);
  }

  if (conversas > 0) {
    // conversation_id é bigint e não precisa ser único entre tenants; a faixa
    // alta evita colidir com conversa real do Chatwoot.
    const base = 9_700_000 + Math.floor(Math.random() * 100_000);
    const linhas = Array.from({ length: conversas }, (_, i) => ({
      tenant_id: tenantId,
      conversation_id: base + i,
      status: 'ativo',
    }));
    const { error } = await admin.from('conversas').insert(linhas);
    if (error) throw new Error(`semear conversas: ${error.message}`);
  }

  if (credencial) {
    const { error } = await admin
      .from('tenant_credenciais')
      .insert({ tenant_id: tenantId, chatwoot_token: `tok-efemero-${tenantId.slice(0, 8)}` });
    if (error) throw new Error(`semear tenant_credenciais: ${error.message}`);
  }
}

/**
 * Confere que o tenant REALMENTE tem o conteúdo semeado.
 *
 * Sem isto, um `insert` que falhasse em silêncio deixaria as asserções de
 * isolamento passando por vacuidade — o defeito que `semearConteudo` existe para
 * eliminar, reintroduzido pela porta de trás.
 */
export async function contarConteudo(admin, tenantId) {
  const [docs, convs, tools, cred] = await Promise.all([
    admin.from('kb_documentos').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId),
    admin.from('conversas').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId),
    admin.from('tenant_tools').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId),
    admin.from('tenant_credenciais').select('tenant_id', { count: 'exact', head: true }).eq('tenant_id', tenantId),
  ]);
  return {
    docs: docs.count ?? 0,
    conversas: convs.count ?? 0,
    tools: tools.count ?? 0,
    credenciais: cred.count ?? 0,
  };
}
