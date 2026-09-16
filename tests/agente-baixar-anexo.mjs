/**
 * `baixarAnexo`: o download do áudio em duas tentativas curtas.
 *
 * O caso que motivou (16/09/2026): o primeiro fetch PENDURA (socket keep-alive
 * morto) e nunca responde; a segunda tentativa, em socket novo, responde em
 * milissegundos. Uma tentativa única de 30 s virava "Não consegui entender seu
 * áudio" para um áudio perfeitamente baixável.
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

/** fetch que pendura até o signal abortar (como o socket morto), sem nunca responder. */
// (`AbortSignal.timeout` usa um timer unref'd no Node: sem algo segurando o
// event loop o processo sairia antes do abort — o `setInterval` é esse algo.)
const pendura = (_u, init) => new Promise((_, reject) => {
  const segura = setInterval(() => {}, 1000);
  init.signal.addEventListener('abort', () => { clearInterval(segura); reject(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })); });
});
const responde = async () => new Response(new Uint8Array([7, 7, 7]), { status: 200 });

console.log('\n== 1. Primeira pendura, segunda responde -> bytes, e o token foi no header ==\n');
{
  let chamadas = 0; let headerVisto = null;
  const fetchFn = (u, init) => { chamadas++; headerVisto = init.headers?.api_access_token ?? null; return chamadas === 1 ? pendura(u, init) : responde(); };
  const t0 = Date.now();
  // Rejeição inesperada vira FALHA, não crash (CLAUDE.md): sem o retry, isto lança.
  let bytes = new Uint8Array(); let erro1 = null;
  try { bytes = await baixarAnexo(fetchFn, 'https://x/anexo.oga', 'tok', [150, 5000]); } catch (e) { erro1 = e; }
  chk('devolveu os 3 bytes da SEGUNDA tentativa (sem lançar)', erro1 === null && bytes.length === 3 && bytes[0] === 7, erro1?.message);
  chk('foram exatamente 2 chamadas', chamadas === 2, String(chamadas));
  chk('a primeira desistiu no timeout curto (< 2 s, não 30)', Date.now() - t0 < 2000, `${Date.now() - t0} ms`);
  chk('o token do bot foi no header api_access_token', headerVisto === 'tok');
}

console.log('\n== 2. Responde de primeira -> UMA chamada ==\n');
{
  let chamadas = 0;
  await baixarAnexo((u, init) => { chamadas++; return responde(); }, 'https://x/a.oga', null, [150, 5000]);
  chk('uma chamada só', chamadas === 1);
}

console.log('\n== 3. As duas falham -> erro que lista as duas causas ==\n');
{
  let chamadas = 0;
  const fetchFn = (u, init) => { chamadas++; return chamadas === 1 ? pendura(u, init) : Promise.resolve(new Response('', { status: 404 })); };
  let erro = null;
  try { await baixarAnexo(fetchFn, 'https://x/a.oga', 'tok', [150, 150]); } catch (e) { erro = e; }
  chk('lança, com "2 tentativas", o TimeoutError e o HTTP 404 no texto', erro && /2 tentativas/.test(erro.message) && /TimeoutError/.test(erro.message) && /HTTP 404/.test(erro.message), erro?.message);
}

console.log(`\n${ok} passaram, ${falhas.length} falharam\n`);
if (falhas.length) process.exit(1);
