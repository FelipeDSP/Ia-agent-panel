// ============================================================================
// EXTRACAO + FILTRAGEM + SANITIZACAO — corpo do no "Extrair e Filtrar"
//
// ESTE ARQUIVO E A FONTE. O JSON do workflow recebe uma copia injetada por
// scripts/gerar-principal.mjs, que substitui o marcador __FILTRO_TEXTO__ pelo
// conteudo de n8n/filtro-texto.js. Editar o no pela UI e perder a alteracao na
// proxima geracao — edite aqui.
//
// POR QUE VIROU ARQUIVO (12/08/2026). Era o no de MAIOR exposicao do repo ainda
// vivendo como string dentro de JSON: 66 linhas, primeiro no depois do webhook,
// no caminho de todo cliente. Se ele quebra, nao ha degradacao parcial — o fluxo
// inteiro para antes de resolver o tenant. O `Consolida Resultado` provou o
// custo dessa forma de guardar codigo no mesmo dia.
//
// Funde 7 nos do fluxo antigo. Retorna SEMPRE 1 item com `acao`:
//   ignorar | midia | bloqueado | processar
//
// NAO carrega token nem URL: isso vem do banco (multi-tenant).
// ============================================================================

const body   = $json.body || {};
const sender = body.sender || {};
const conv   = body.conversation || {};

const base = {
  conversation_id: conv.id ?? null,
  chatwoot_account_id: body.account?.id ?? null,
  contact_name: sender.name || 'Cliente',
  phone: (sender.phone_number || '').replace(/\D/g, '') || null
};

const out = (acao, extra = {}) => [{ json: { ...base, acao, ...extra } }];

// 1. Grupo de WhatsApp
if ((sender.identifier || '').endsWith('@g.us')) {
  return out('ignorar', { motivo: 'grupo' });
}

// 2. Contato tecnico da integracao
if (base.contact_name === 'Integração WhatsApp') {
  return out('ignorar', { motivo: 'integracao' });
}

// 3. Story mention do Instagram
const primeira = conv.messages?.[0]?.content || '';
const tipoAnexo = body.content_attributes?.image_type || '';
if (primeira.includes('mentioned you in the story') || tipoAnexo === 'story_mention') {
  return out('ignorar', { motivo: 'story_mention' });
}

// 4. Midia sem texto
const texto = (body.content || '').trim();
const temAnexo = Array.isArray(body.attachments) && body.attachments.length > 0;
if (!texto) {
  return temAnexo ? out('midia') : out('ignorar', { motivo: 'sem_texto' });
}

// 5. Prompt injection + 6. Sanitizacao
// O bloco abaixo e injetado de n8n/filtro-texto.js e e o MESMO usado no filtro
// da transcricao de audio. Nao edite aqui: edite a fonte.
// __FILTRO_TEXTO__

if (contemInjection(texto)) {
  return out('bloqueado');
}

const mensagem = sanitizar(texto);
if (!mensagem) {
  return out('ignorar', { motivo: 'vazio_pos_sanitizacao' });
}

return out('processar', { mensagem });
