/**
 * O agente sabe que dia é hoje — a correção da conversa 48 do Empório.
 *
 * O CASO: domingo, 04/10/2026, 07:09 em Porto Velho. "Vocês abrem hoje para o
 * café?" → "Hoje o Empório está fechado, pois fechamos às segundas-feiras.
 * Posso deixar separado para buscar amanhã, quando abrirmos às 7h?". Era
 * domingo (abre 8h, dali a 50 min) e "amanhã" era a segunda, o único dia
 * fechado. O prompt do cliente estava CERTO; o que faltava era o modelo saber
 * a data — ela não aparecia em lugar nenhum do que ele recebia.
 *
 * O teste é puro e com instante FIXO: um que dependesse do relógio da máquina
 * repetiria o erro que ele existe para pegar (e já derrubou `disponivelAgora`
 * às 18:01 de um dia qualquer, em 16/09).
 *
 *   npm run teste:relogio-do-agente
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { narrarAgora, FUSO_PADRAO } = await import(new URL('../agente/src/turno/agora.ts', import.meta.url).href);

let ok = 0;
const falhas = [];
const chk = (nome, cond, det = '') => {
  if (cond) { ok++; console.log(`  OK    ${nome}`); }
  else { falhas.push(nome); console.log(`  FALHA ${nome}${det ? ` — ${det}` : ''}`); }
};

console.log('\n== 1. O instante da conversa 48 ==\n');
{
  // 2026-10-04T11:09:14Z = domingo, 07:09 em Porto Velho (UTC-4).
  const t = new Date('2026-10-04T11:09:14.703Z');
  const texto = narrarAgora(t, 'America/Porto_Velho');
  chk('diz o DIA DA SEMANA, que é o que faltava', /domingo/.test(texto), texto);
  chk('diz a data e a hora no fuso do tenant (07:09, não 11:09)', /04\/10\/2026/.test(texto) && /07:09/.test(texto), texto);
  chk('nomeia o fuso, para não parecer hora de outro lugar', /America\/Porto_Velho/.test(texto));
  chk('declara que é fato do SISTEMA, não fala do cliente (o modelo não pode ser convencido do contrário)', /FATO DO SISTEMA/.test(texto));
  chk('manda usar nisso e proíbe supor o dia', /nunca suponha o dia da semana/i.test(texto));
  // A contraprova do bug: no fuso errado o mesmo instante vira OUTRO dia/hora.
  const emSP = narrarAgora(t, 'America/Sao_Paulo');
  chk('CONTRAPROVA: o fuso muda a hora narrada (08:09 em SP) — por isso ele vem do tenant', /08:09/.test(emSP), emSP);
}

console.log('\n== 2. Fuso: do tenant, com padrão e sem quebrar ==\n');
{
  const t = new Date('2026-10-04T11:09:14.703Z');
  chk('sem fuso configurado, usa o padrão do serviço e o nomeia', narrarAgora(t, null).includes(FUSO_PADRAO) && narrarAgora(t, '  ').includes(FUSO_PADRAO));
  chk('fuso inválido não derruba o turno: cai no padrão', narrarAgora(t, 'Marte/Olympus').includes(FUSO_PADRAO));
}

console.log('\n== 3. Os sete dias, e as bordas ==\n');
{
  // 05/10/2026 é segunda; a semana inteira a partir dali.
  const esperado = ['segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado', 'domingo'];
  const vistos = esperado.map((_, i) => {
    const d = new Date(Date.UTC(2026, 9, 5 + i, 15, 0, 0));
    return (narrarAgora(d, 'America/Porto_Velho').match(/agora é ([^,]+),/) ?? [])[1];
  });
  chk('os sete dias saem certos e em ordem', JSON.stringify(vistos) === JSON.stringify(esperado), JSON.stringify(vistos));
  // Meia-noite: `hour12: false` devolve "24" em algumas plataformas.
  const meiaNoite = narrarAgora(new Date('2026-10-05T04:00:00Z'), 'America/Porto_Velho'); // 00:00 em Porto Velho
  chk('meia-noite é 00:00, nunca 24:00', /00:00/.test(meiaNoite) && !/24:00/.test(meiaNoite), meiaNoite);
  // Virada de dia pelo fuso: 02:00Z de 05/10 ainda é 22:00 de 04/10 (domingo) em Porto Velho.
  const virada = narrarAgora(new Date('2026-10-05T02:00:00Z'), 'America/Porto_Velho');
  chk('a virada do dia respeita o fuso (ainda domingo 04/10 às 22:00)', /domingo/.test(virada) && /04\/10\/2026/.test(virada) && /22:00/.test(virada), virada);
}

console.log('\n== 4. Entra pelo ESTADO DO SISTEMA, não pelo prompt ==\n');
{
  const exec = fs.readFileSync(path.join(RAIZ, 'agente/src/turno/executar.ts'), 'utf8');
  chk('o turno narra o relógio junto do estado do sistema', /narrarEstadoDoSistema\(db, tenant\.tenant_id, conversationId, perfil, \{/.test(exec));
  chk('e passa o fuso do horário do tenant', /timezone: \(horario as/.test(exec));
  const prompt = fs.readFileSync(path.join(RAIZ, 'agente/src/agente/prompt.ts'), 'utf8');
  chk('o PROMPT não ganhou data nenhuma (ele é cacheado e tem hash; data ali mataria o cache e encheria agente_prompts)',
    !/narrarAgora|new Date\(\)|toLocaleDateString/.test(prompt));
  // O relógio não pode depender do perfil: "abre hoje?" não é pergunta de venda.
  chk('o relógio é narrado antes de qualquer coisa de vendas (vale para todo perfil)',
    /const partes: string\[\] = \[narrarAgora\(/.test(exec));
}

console.log(`\n${ok} passaram, ${falhas.length} falharam\n`);
if (falhas.length) process.exit(1);
