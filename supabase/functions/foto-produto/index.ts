// Edge Function: foto-produto
//
// Assina uma URL de leitura, de vida curta, para uma foto de produto no bucket
// PRIVADO `produto-fotos`. Chamada pelo n8n, dentro do sub-workflow que envia a
// foto ao cliente pelo Chatwoot.
//
// ----------------------------------------------------------------------------
// POR QUE ESTA FUNCAO EXISTE
// ----------------------------------------------------------------------------
// O n8n nao tem como falar com o Storage. As credenciais dele sao `postgres`,
// `redis`, `openAiApi` e `wahaApi` — nenhuma de Storage. A alternativa seria pôr
// a `service_role` la dentro, e isso daria ao n8n o banco INTEIRO: o oposto do
// que a migracao 21 fez ao tirar o token do Chatwoot da tabela de tenants.
//
// Aqui o n8n ganha um segredo que serve para UMA coisa: assinar leitura de uma
// foto, dentro da pasta do proprio tenant.
//
// A alternativa mais simples — bucket publico — foi descartada: e dado do
// cliente, e o teste de 11/08 provou que nenhuma URL nossa precisa chegar ao
// WhatsApp, porque o Chatwoot RE-HOSPEDA a imagem que recebe.
//
// ----------------------------------------------------------------------------
// O QUE ELA NAO FAZ
// ----------------------------------------------------------------------------
// NAO decide se a foto pode ser enviada. Quem decide e
// `api_n8n_enviar_foto` (migracao 35), que o sub-workflow chama ANTES: ela
// confere contratacao, produto, janela, e REGISTRA a tentativa. Esta funcao so
// assina o que aquela ja autorizou.
//
// Duplicar a decisao aqui criaria duas verdades sobre a mesma coisa — foi
// exatamente o problema que a migracao 30 consertou entre `api_n8n_tools_ativas`
// e `api_n8n_config_tool`.
//
// ----------------------------------------------------------------------------
// A TRAVA QUE ELA TEM
// ----------------------------------------------------------------------------
// O path pedido PRECISA comecar por `{tenant_id}/`. Mesmo com o segredo em maos,
// nao da para assinar a foto de outro tenant: e a mesma regra das policies de
// Storage (migracao 34), repetida aqui porque a service_role ignora RLS.
//
// Publicada com verify_jwt = false; o header x-foto-secret e o unico portao —
// mesmo padrao do processar-ingestao, com segredo PROPRIO. Dar o
// INGESTAO_SECRET ao n8n permitiria a ele disparar ingestao, que nao e da conta
// dele.

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.58.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const FOTO_SECRET = Deno.env.get('FOTO_SECRET')!;

const BUCKET = 'produto-fotos';

// Segundos de vida da assinatura. O unico consumidor e o proprio n8n, dentro da
// execucao: ele baixa e reenvia em seguida. Nao ha fetch do WhatsApp para
// esperar, entao nao ha razao para durar mais.
const VALIDADE_SEGUNDOS = 60;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// Comparacao de tempo constante, igual a do processar-ingestao. Fail-closed
// contra misconfig: segredo vazio ou curto fecha o portao em vez de abri-lo —
// comparar dois vazios daria `true`.
function segredoConfere(recebido: string | null): boolean {
  if (!FOTO_SECRET || FOTO_SECRET.length < 24) return false;
  if (recebido === null || recebido.length !== FOTO_SECRET.length) return false;
  let diff = 0;
  for (let i = 0; i < recebido.length; i++) {
    diff |= recebido.charCodeAt(i) ^ FOTO_SECRET.charCodeAt(i);
  }
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ erro: 'Use POST.' }, 405);

  if (!segredoConfere(req.headers.get('x-foto-secret'))) {
    return json({ erro: 'Nao autorizado.' }, 401);
  }

  let corpo: { tenant_id?: string; foto_path?: string };
  try {
    corpo = await req.json();
  } catch {
    return json({ erro: 'Corpo JSON invalido.' }, 400);
  }

  const tenantId = String(corpo.tenant_id ?? '');
  const fotoPath = String(corpo.foto_path ?? '');

  if (!UUID.test(tenantId)) return json({ erro: 'tenant_id invalido.' }, 400);
  if (!fotoPath) return json({ erro: 'foto_path obrigatorio.' }, 400);

  // A trava. `startsWith` com a barra impede tanto pasta alheia quanto o truque
  // do prefixo — um tenant cujo id fosse prefixo de outro nao existe com UUID,
  // mas a barra torna isso explicito em vez de sorte.
  if (!fotoPath.startsWith(`${tenantId}/`)) {
    return json({ erro: 'foto_path fora da pasta do tenant.' }, 403);
  }
  // `..` sobe pasta e escaparia da checagem acima depois da normalizacao do
  // Storage. Nao ha caso legitimo com isso no path.
  if (fotoPath.includes('..')) {
    return json({ erro: 'foto_path invalido.' }, 400);
  }

  const { data, error } = await admin.storage
    .from(BUCKET)
    .createSignedUrl(fotoPath, VALIDADE_SEGUNDOS);

  if (error || !data?.signedUrl) {
    // 404 e o caso comum: coluna aponta para arquivo que nao existe mais. Vale
    // distinguir do erro de infraestrutura, porque o sub-workflow trata
    // diferente — um vira "nao consegui mandar a foto", o outro vira alarme.
    const ausente = /not.?found|does not exist/i.test(error?.message ?? '');
    return json(
      { erro: ausente ? 'Foto nao encontrada no Storage.' : `Falha ao assinar: ${error?.message}` },
      ausente ? 404 : 500,
    );
  }

  return json({ url: data.signedUrl, validade_segundos: VALIDADE_SEGUNDOS });
});
