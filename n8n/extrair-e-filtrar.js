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

// `chatwoot_inbox_id` entra aqui na migracao 54: o roteamento deixou de ser por
// CONTA e passou a ser pelo PAR (conta, caixa), porque o bot do Chatwoot e ligado
// a uma inbox e nao a conta — dois agentes do mesmo cliente cabem em duas caixas
// da mesma conta.
//
// AS DUAS FONTES, e por que nesta ordem. Confirmado em payload real de
// `message_created`, o inbox aparece em tres lugares:
//
//   body.conversation.inbox_id               189
//   body.conversation.contact_inbox.inbox_id 189
//   body.inbox.id                            189   (+ .name "WA - Testes")
//
// `conversation.inbox_id` vem primeiro porque `conversation` e o objeto que todo
// evento de mensagem carrega; `body.inbox` e o reforco. Nao ha payload
// `outgoing` medido, e o ramo de pausa e outgoing — o `??` existe para isso.
//
// Nulo aqui NAO e tratado com valor de reserva de proposito: a
// `api_n8n_tenant_por_chatwoot` estoura 22023 em caixa nula, e e o que se quer.
// Chutar um numero faria o webhook resolver o tenant errado em silencio.
const base = {
  conversation_id: conv.id ?? null,
  chatwoot_account_id: body.account?.id ?? null,
  chatwoot_inbox_id: conv.inbox_id ?? body.inbox?.id ?? null,
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
  if (!temAnexo) return out('ignorar', { motivo: 'sem_texto' });

  // O ramo de audio precisa destes campos, e so ele os le. Para todo o resto a
  // `acao` continua sendo 'midia' exatamente como antes — o acrescimo e aditivo.
  //
  // Confirmado contra webhook real de nota de voz (12/08/2026):
  //   file_type "audio" | file_size 5124 | extension null
  //   data_url  .../active_storage/blobs/redirect/<token>/no-filename.oga
  //
  // A EXTENSAO vem da URL, nao do campo `extension`: ele veio null no payload
  // real. E ela importa porque a API de transcricao decide o parser pelo nome do
  // arquivo no multipart — mandar `.bin` faz a chamada falhar.
  const a = body.attachments[0] || {};
  const url = String(a.data_url || '').split('?')[0];
  const casa = url.match(/\.([a-z0-9]{2,5})$/i);

  return out('midia', {
    anexo: {
      file_type: a.file_type ?? null,
      data_url: a.data_url ?? null,
      file_size: Number(a.file_size) || 0,
      extensao: casa ? casa[1].toLowerCase() : ''
    }
  });
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
