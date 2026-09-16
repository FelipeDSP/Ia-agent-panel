/**
 * `baixarAnexo`: esperar o arquivo EXISTIR no storage do Chatwoot.
 *
 * Medido em 16/09/2026 (três áudios reais no sendbox): o webhook chega ~26 s
 * ANTES de o arquivo estar no S3; a URL `proxy` pendura nesse intervalo; a
 * `redirect` responde 302 na hora e o S3 devolve 404 até o arquivo chegar.
 *
 * O teste simula um Chatwoot com relógio falso: o storage passa a ter o
 * arquivo em T+26 s. Tempo e sono são injetados — o teste roda em ms.
 *
 *   node tests/agente-baixar-anexo.mjs
 */
import { baixarAnexo } from '../agente/src/midia/transcrever.ts';

let ok = 0;
const falhas = [];
const chk = (nome, cond, det = '') => {
  if (cond) { ok++; console.log(`  OK    ${nome}`); }
  else { falhas.push(nome); console.log(`  FALHA ${nome}${det ? ` — ${det}` : ''}`); }
};

const PROXY = 'https://chatwoot.teste/rails/active_storage/blobs/proxy/TOKEN/no-filename.oga';
const S3 = 'https://bucket.s3.teste/chave?assinatura=1';

/** Um Chatwoot falso cujo arquivo aparece no storage em `prontoEm` ms de relógio simulado. */
function chatwootFalso({ prontoEm, temRedirect = true }) {
  let relogio = 0;
  const chamadas = [];
  const fetchFn = async (u, init) => {
    chamadas.push({ u: String(u), headers: init?.headers ?? {} });
    if (String(u).includes('/blobs/redirect/')) {
      if (!temRedirect) return new Response('', { status: 404 });
      return new Response('', { status: 302, headers: { location: S3 } });
    }
    if (String(u) === S3) return relogio >= prontoEm ? new Response(new Uint8Array([7, 7, 7]), { status: 200 }) : new Response('', { status: 404 });
    if (String(u).includes('/blobs/proxy/')) {
      // o proxy PENDURA antes de o arquivo existir: simula-se como "o timeout da
      // tentativa passou" (o relógio avança o timeout) e a rejeição do abort.
      if (relogio >= prontoEm) return new Response(new Uint8Array([7, 7, 7]), { status: 200 });
      relogio += 8_000;
      throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    }
    return new Response('', { status: 500 });
  };
  const opcoes = {
    prazoMs: 75_000, intervaloMs: 3_000, timeoutTentativaMs: 8_000,
    agora: () => relogio,
    dormir: async (ms) => { relogio += ms; },   // dormir avança o relógio simulado
  };
  return { fetchFn, opcoes, chamadas, agora: () => relogio };
}

console.log('\n== 1. Arquivo aparece em T+26 s: espera, segue o redirect, baixa do S3 sem o token ==\n');
{
  const cw = chatwootFalso({ prontoEm: 26_000 });
  let r = null; let erro = null;
  try { r = await baixarAnexo(cw.fetchFn, PROXY, 'tok', cw.opcoes); } catch (e) { erro = e; }
  chk('baixou 3 bytes, via redirect', erro === null && r.bytes.length === 3 && r.via === 'redirect', erro?.message);
  chk('esperou 27 s de relógio em 10 tentativas (a cada 3 s), sem pendurar', r && r.esperaMs === 27_000 && r.tentativas === 10, JSON.stringify({ e: r?.esperaMs, t: r?.tentativas }));
  const aoChatwoot = cw.chamadas.filter((c) => c.u.includes('chatwoot.teste'));
  const aoS3 = cw.chamadas.filter((c) => c.u === S3);
  chk('o token foi SÓ ao Chatwoot, nunca ao storage (contraprova: houve chamadas aos dois)',
    aoChatwoot.length > 0 && aoS3.length > 0 && aoChatwoot.every((c) => c.headers.api_access_token === 'tok') && aoS3.every((c) => !c.headers.api_access_token));
  chk('nenhuma tentativa usou a URL `proxy` (que pendura)', !cw.chamadas.some((c) => c.u.includes('/blobs/proxy/')));
}

console.log('\n== 2. Arquivo já existe: UMA tentativa, sem espera ==\n');
{
  const cw = chatwootFalso({ prontoEm: 0 });
  const r = await baixarAnexo(cw.fetchFn, PROXY, 'tok', cw.opcoes);
  chk('1 tentativa, espera 0', r.tentativas === 1 && r.esperaMs === 0, JSON.stringify({ t: r.tentativas, e: r.esperaMs }));
}

console.log('\n== 3. Nunca aparece: desiste no prazo, erro com a contagem e as causas ==\n');
{
  const cw = chatwootFalso({ prontoEm: Infinity });
  let erro = null;
  try { await baixarAnexo(cw.fetchFn, PROXY, 'tok', cw.opcoes); } catch (e) { erro = e; }
  chk('lança citando tentativas e "storage HTTP 404"', erro && /tentativas/.test(erro.message) && /storage HTTP 404/.test(erro.message), erro?.message);
  chk('respeitou o prazo (relógio <= 75 s) e tentou mais de 20 vezes', cw.agora() <= 75_000 && /em 2[0-9] tentativas/.test(erro?.message ?? ''), `${cw.agora()} ms — ${erro?.message}`);
}

console.log('\n== 4. Instância sem rota `redirect`: cai no `proxy` com timeout curto e baixa quando o arquivo chega ==\n');
{
  const cw = chatwootFalso({ prontoEm: 26_000, temRedirect: false });
  let r = null; let erro = null;
  try { r = await baixarAnexo(cw.fetchFn, PROXY, 'tok', cw.opcoes); } catch (e) { erro = e; }
  chk('baixou via proxy depois que o arquivo existiu', erro === null && r?.via === 'proxy' && r.bytes.length === 3, erro?.message ?? JSON.stringify(r));
  chk('levou mais de uma tentativa (a rota ausente e os timeouts do proxy foram engolidos, não crasharam)', r?.tentativas > 1, String(r?.tentativas));
}

console.log('\n== 5. URL que não é do Chatwoot: download direto ==\n');
{
  const fetchFn = async () => new Response(new Uint8Array([1]), { status: 200 });
  const r = await baixarAnexo(fetchFn, 'https://outro.teste/a.oga', null, { agora: () => 0, dormir: async () => {} });
  chk('via direto, 1 tentativa', r.via === 'direto' && r.tentativas === 1);
}

console.log(`\n${ok} passaram, ${falhas.length} falharam\n`);
if (falhas.length) process.exit(1);
