#!/usr/bin/env node
/**
 * Isolamento do bucket `produto-fotos` — TRÊS tenants, incluindo URL direta.
 *
 * Foto de produto é o primeiro dado de cliente que este projeto guarda como
 * ARQUIVO acessível por URL. Um vazamento aqui não é "o tenant B viu uma linha
 * a mais": é a foto do prato de um restaurante servida para outro, ou para
 * qualquer um com o link.
 *
 * Três tenants e não dois, como manda o `CLAUDE.md`: com dois, um vazamento
 * unidirecional passa. O terceiro (C) confirma que a barreira não é uma
 * simetria acidental entre A e B.
 *
 * Cobre os dois caminhos que importam:
 *   - pela API autenticada, com o JWT de outro tenant (RLS de storage.objects);
 *   - por URL DIRETA, sem autenticação nenhuma — que é como um link vazado
 *     seria explorado.
 *
 * E cobre as duas garantias que o bucket dá e o navegador não:
 *   - MIME fora da allowlist é recusado;
 *   - arquivo acima de 512 KB é recusado.
 *
 * Essas duas são o motivo de o redimensionamento no navegador ser otimização e
 * não garantia. Se elas caírem, a promessa de "os 3 MB não trafegam" vira fé.
 *
 * Uso: node tests/isolamento-fotos.mjs   (npm run teste:fotos)
 */

import { createClient } from '@supabase/supabase-js';

import { carregarEnv } from '../scripts/lib/env.mjs';
import { criarUsuario, ehEmailDuplicado, removerPorEmail, removerPorId } from '../scripts/lib/usuarios.mjs';
import { criarTenantsEfemeros, removerTenantsEfemeros } from './lib/tenants-efemeros.mjs';

carregarEnv();

const URL_SB = process.env.NEXT_PUBLIC_SUPABASE_URL;
const PUBLICA = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const SECRETA = process.env.SUPABASE_SECRET_KEY;

if (!URL_SB || !PUBLICA || !SECRETA) {
  console.error('\n  Faltam variáveis no .env.local.\n');
  process.exit(1);
}

const SENHA = 'IsolamentoFotos#2026';
const BUCKET = 'produto-fotos';
/*
 * SEM SLUG DE SEED. Os três tenants são criados por este teste e destruídos por
 * ele. Antes eram `clinica-teste`, `restaurante-teste` e `sandbox-de-testes`
 * resolvidos por slug — e quando dois deles foram soft-deletados pelo painel em
 * 13/08 a suíte de isolamento ficou quatro dias cega. O critério agora é o de
 * `docs/PENDENCIA-SEED-DOS-TESTES.md`: apagar seed nenhum consegue deixar este
 * teste verde, porque ele não olha para seed nenhum.
 *
 * Continuam TRÊS: um esconde todo bug de isolamento, dois escondem vazamento
 * unidirecional.
 */
const MARCA_TENANT = 'fotos';
const MARCA_PRODUTO = '__teste_iso_foto__';

const admin = createClient(URL_SB, SECRETA, { auth: { autoRefreshToken: false, persistSession: false } });

let passou = 0;
const falhas = [];
const checar = (nome, ok, detalhe = '') => {
  if (ok) { passou++; console.log(`  OK    ${nome}`); }
  else { falhas.push(`${nome}${detalhe ? ` — ${detalhe}` : ''}`); console.log(`  FALHA ${nome}${detalhe ? ` — ${detalhe}` : ''}`); }
};

async function autenticar(email) {
  const c = createClient(URL_SB, PUBLICA, { auth: { autoRefreshToken: false, persistSession: false } });
  const { error } = await c.auth.signInWithPassword({ email, password: SENHA });
  if (error) throw new Error(`login falhou (${email}): ${error.message}`);
  return c;
}

// JPEG mínimo válido (SOI + EOI). Basta para o Storage aceitar como image/jpeg.
/*
 * `Boolean(error)` NAO BASTA, e o motivo foi medido, nao suposto.
 *
 * Sondagem em producao, com cliente autenticado:
 *
 *   bucket certo, objeto alheio  -> "Object not found"   (404)
 *   BUCKET ERRADO                -> "Bucket not found"   (404)
 *   Boolean(error) nos dois      -> true / true          NAO DISTINGUE
 *
 * Ou seja: no dia em que o bucket for renomeado, toda assercao de recusa deste
 * arquivo passa a "confirmar" um isolamento que nao esta sendo exercido — e as
 * duas piores sao o teto de 512 KB e a allowlist de MIME, que passariam a
 * atestar limites que ninguem aplica.
 *
 * `recusaDePolicy` exige que a recusa NAO seja "bucket inexistente". Os limites
 * do bucket vao mais longe e conferem o codigo exato (413 e 415), porque ali o
 * que se afirma e QUAL regra recusou, nao apenas que houve recusa.
 */
function recusaDePolicy(r) {
  const msg = r?.error?.message ?? '';
  return Boolean(r?.error) && !/bucket not found/i.test(msg);
}

/** Detalhe util quando a assercao acima reprova. */
function motivo(r) {
  if (!r?.error) return 'NAO houve recusa';
  return `${r.error.message} (${r.error.statusCode ?? '?'})`;
}

const jpegMinimo = () => new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9])], { type: 'image/jpeg' });

async function main() {
  /** Preenchido logo abaixo; declarado aqui para o `finally` alcançar. */
  let efemeros = [];
  console.log('\n== Isolamento das fotos de produto ==\n');

  efemeros = await criarTenantsEfemeros(admin, { marca: MARCA_TENANT });
  const [A, B, C] = efemeros;
  console.log(`  tenants efêmeros: ${efemeros.map((t) => t.slug).join(', ')}\n`);

  const emails = {
    A: 'teste-fotos-a@exemplo.invalido',
    B: 'teste-fotos-b@exemplo.invalido',
    C: 'teste-fotos-c@exemplo.invalido',
  };
  const ids = { A: null, B: null, C: null };
  let prodCriadoId = null;
  const pathA = `${A.id}/00000000-0000-0000-0000-00000000000a.jpg`;
  const pathB = `${B.id}/00000000-0000-0000-0000-00000000000b.jpg`;

  async function limparObjetos() {
    for (const p of [pathA, pathB, `${A.id}/invasao.jpg`]) {
      await admin.storage.from(BUCKET).remove([p]);
    }
  }

  try {
    async function criar(email, tenantId) {
      const meta = { tenant_id: tenantId, role: 'tenant_admin' };
      let { data, error } = await criarUsuario(admin, {
        email, password: SENHA, email_confirm: true, app_metadata: meta, user_metadata: { nome: email },
      });
      if (error && ehEmailDuplicado(error)) {
        await removerPorEmail(admin, email, { tentativas: 5 });
        ({ data, error } = await criarUsuario(admin, {
          email, password: SENHA, email_confirm: true, app_metadata: meta, user_metadata: { nome: email },
        }));
      }
      if (error) throw new Error(`criar ${email}: ${error.message}`);
      return data.user.id;
    }

    await limparObjetos();
    ids.A = await criar(emails.A, A.id);
    ids.B = await criar(emails.B, B.id);
    ids.C = await criar(emails.C, C.id);

    const cA = await autenticar(emails.A);
    const cB = await autenticar(emails.B);
    const cC = await autenticar(emails.C);

    // -----------------------------------------------------------------------
    console.log('  -- o dono sobe e lê a própria foto --');
    const up = await cA.storage.from(BUCKET).upload(pathA, jpegMinimo(), { contentType: 'image/jpeg', upsert: true });
    checar('A sobe na própria pasta', !up.error, up.error?.message);

    const leA = await cA.storage.from(BUCKET).download(pathA);
    checar('A baixa a própria foto', !leA.error && leA.data, leA.error?.message);

    const upB = await cB.storage.from(BUCKET).upload(pathB, jpegMinimo(), { contentType: 'image/jpeg', upsert: true });
    checar('B sobe na própria pasta', !upB.error, upB.error?.message);

    // -----------------------------------------------------------------------
    console.log('\n  -- outro tenant não alcança (API autenticada) --');
    for (const [nome, cli] of [['B', cB], ['C', cC]]) {
      const r = await cli.storage.from(BUCKET).download(pathA);
      checar(`${nome} NÃO baixa a foto de A`, recusaDePolicy(r) || (!r.error && !r.data), motivo(r));

      const l = await cli.storage.from(BUCKET).list(A.id);
      checar(`${nome} NÃO lista a pasta de A`, !l.error && (l.data ?? []).length === 0,
        l.error ? l.error.message : `${l.data?.length} item(ns)`);
    }

    // Escrever na pasta alheia é o vazamento na direção contrária: não é ler o
    // dado do outro, é plantar dado no outro.
    const invasao = await cB.storage.from(BUCKET)
      .upload(`${A.id}/invasao.jpg`, jpegMinimo(), { contentType: 'image/jpeg', upsert: true });
    checar('B NÃO sobe dentro da pasta de A', recusaDePolicy(invasao), motivo(invasao));

    const rem = await cB.storage.from(BUCKET).remove([pathA]);
    const aindaLa = await cA.storage.from(BUCKET).download(pathA);
    checar('B NÃO apaga a foto de A', !aindaLa.error && Boolean(aindaLa.data),
      rem.error ? '' : 'o remove não deu erro E o arquivo sumiu');

    // -----------------------------------------------------------------------
    console.log('\n  -- URL direta, sem autenticação nenhuma --');
    // É assim que um link vazado seria explorado: alguém cola a URL no browser.
    const urlPublica = `${URL_SB}/storage/v1/object/public/${BUCKET}/${pathA}`;
    const rPub = await fetch(urlPublica);
    checar('URL pública direta é recusada (bucket privado)', !rPub.ok, `HTTP ${rPub.status}`);

    const urlAutenticada = `${URL_SB}/storage/v1/object/${BUCKET}/${pathA}`;
    const rSemToken = await fetch(urlAutenticada);
    checar('URL autenticada sem token é recusada', !rSemToken.ok, `HTTP ${rSemToken.status}`);

    // Com o token do OUTRO tenant: o caso realista de quem tem conta no produto.
    const { data: sessaoB } = await cB.auth.getSession();
    const rTokenB = await fetch(urlAutenticada, {
      headers: { Authorization: `Bearer ${sessaoB.session.access_token}`, apikey: PUBLICA },
    });
    checar('URL com o token de B é recusada para o objeto de A', !rTokenB.ok, `HTTP ${rTokenB.status}`);

    // A URL assinada é um portador: quem tiver o link entra, e é por isso que
    // ela tem de ser curta. O que se testa aqui é que ela só existe para quem
    // já podia ler — B não consegue nem gerá-la.
    const assinadaB = await cB.storage.from(BUCKET).createSignedUrl(pathA, 60);
    checar('B NÃO consegue assinar URL do objeto de A',
      recusaDePolicy(assinadaB) || (!assinadaB.error && !assinadaB.data?.signedUrl),
      motivo(assinadaB));

    // -----------------------------------------------------------------------
    console.log('\n  -- as garantias que o navegador não dá --');
    const grande = new Blob([new Uint8Array(600 * 1024)], { type: 'image/jpeg' });
    const rGrande = await cA.storage.from(BUCKET)
      .upload(`${A.id}/grande.jpg`, grande, { contentType: 'image/jpeg', upsert: true });
    // 413 e o codigo do teto. Qualquer outro erro aqui (bucket errado, rede,
    // permissao) significa que o teto NAO foi exercido — e era isso que
    // `Boolean(error)` deixava passar como se fosse prova.
    checar('arquivo acima de 512 KB é recusado pelo bucket (413)',
      rGrande.error?.statusCode === '413',
      rGrande.error ? `veio ${motivo(rGrande)}` : 'subiu — o teto não está valendo');

    const pdf = new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46])], { type: 'application/pdf' });
    const rPdf = await cA.storage.from(BUCKET)
      .upload(`${A.id}/doc.pdf`, pdf, { contentType: 'application/pdf', upsert: true });
    // 415 = unsupported media type. Mesmo raciocinio do teto acima.
    checar('MIME fora da allowlist é recusado (415)',
      rPdf.error?.statusCode === '415',
      rPdf.error ? `veio ${motivo(rPdf)}` : 'subiu — a allowlist não está valendo');

    // -----------------------------------------------------------------------
    console.log('\n  -- a coluna acompanha o isolamento --');
    // O bucket protegido não basta: se B conseguisse escrever `foto_path` num
    // produto de A, apontaria a foto de A para um path que B controla.
    const { data: criado, error: erroCriar } = await admin.from('produtos')
      .insert({ tenant_id: A.id, nome: MARCA_PRODUTO, preco_centavos: 100, unidade: 'un' })
      .select('id, foto_path')
      .single();
    if (erroCriar) throw new Error(`criar produto de A: ${erroCriar.message}`);
    prodCriadoId = criado.id;

    await cB.from('produtos').update({ foto_path: pathB }).eq('id', criado.id);
    const { data: depois } = await admin.from('produtos')
      .select('foto_path').eq('id', criado.id).single();
    checar('B NÃO grava foto_path em produto de A', depois?.foto_path === null,
      `ficou ${JSON.stringify(depois?.foto_path)}`);

    // Contraprova na direção certa: o dono grava. Sem ela, uma policy que
    // bloqueasse TODO MUNDO passaria neste teste como se estivesse correta.
    await cA.from('produtos').update({ foto_path: pathA }).eq('id', criado.id);
    const { data: comFoto } = await admin.from('produtos')
      .select('foto_path').eq('id', criado.id).single();
    checar('A grava foto_path no próprio produto', comFoto?.foto_path === pathA,
      `ficou ${JSON.stringify(comFoto?.foto_path)}`);
  } finally {
    if (prodCriadoId) await admin.from('produtos').delete().eq('id', prodCriadoId);
    // Escopado por tenant: o `like` sozinho varria a tabela inteira como
    // service_role. Ver a mesma correção em isolamento-produtos.mjs.
    await admin
      .from('produtos')
      .delete()
      .in('tenant_id', [A.id, B.id, C.id])
      .like('nome', `${MARCA_PRODUTO}%`);
    await limparObjetos();
    for (const p of ['grande.jpg', 'doc.pdf']) await admin.storage.from(BUCKET).remove([`${A.id}/${p}`]);
    for (const k of ['A', 'B', 'C']) if (ids[k]) await removerPorId(admin, ids[k]);
    // Os tenants saem por ULTIMO: as 13 FKs sao CASCADE, e apaga-los antes
    // levaria junto as linhas que as limpezas acima precisam encontrar para
    // provar que fizeram o proprio trabalho.
    const sobraram = await removerTenantsEfemeros(admin, efemeros);
    if (sobraram.length) {
      console.log(`  ATENCAO: tenants efemeros nao removidos: ${sobraram.join(', ')}`);
      falhas.push(`sobrou tenant efemero: ${sobraram.join(', ')}`);
    }
  }
}

await main();

console.log(`\n${'-'.repeat(60)}`);
console.log(`  ${passou} passaram, ${falhas.length} falharam`);
if (falhas.length) {
  console.log('\n  FALHAS:');
  for (const f of falhas) console.log(`    - ${f}`);
  console.log('\n  NÃO construa UI em cima disto.\n');
  process.exit(1);
}
console.log('\n  Bucket isolado: nem por API, nem por URL direta.\n');
