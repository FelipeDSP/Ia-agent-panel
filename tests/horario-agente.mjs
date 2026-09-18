/**
 * Horário do agente (74) — as duas leituras puras: a do serviço
 * (`agente/src/tenant/horario.ts`: `situacao`, texto do aviso, linha do prompt)
 * e a do painel (`src/lib/tenants/horario-agente.ts`: validador e datas).
 *
 * Nenhuma asserção usa o relógio de parede: toda `situacao` recebe a data.
 *
 *   node --import ./tests/lib/ts.mjs tests/horario-agente.mjs
 */
import { lerHorarioAgente, situacao, textoDoAviso, linhaDoPromptFechado } from '../agente/src/tenant/horario.ts';
import { validarHorarioAgente, lerDatasFechadas, lerHorarioAgente as lerPainel, datasParaExibir } from '../src/lib/tenants/horario-agente.ts';

let ok = 0;
const falhas = [];
const chk = (nome, cond, det = '') => {
  if (cond) { ok++; console.log(`  OK    ${nome}`); }
  else { falhas.push(nome); console.log(`  FALHA ${nome}${det ? ` — ${det}` : ''}`); }
};

console.log('\n== serviço: situacao() ==\n');
// Empório: Porto Velho (UTC-4), terça a sábado, 8–18, fechado 25/12
const H = lerHorarioAgente({ timezone: 'America/Porto_Velho', dias_semana: [2, 3, 4, 5, 6], hora_inicio: 8, hora_fim: 18, fechados: ['2026-12-25'], fora_horario: 'aviso' });
const em = (iso) => new Date(iso);
{
  chk('sem horário (null) -> sempre aberto', situacao(null, em('2026-09-14T19:00:00Z')).aberto === true);
  const seg = situacao(H, em('2026-09-14T19:00:00Z'));   // segunda 15h local
  chk('segunda 15h -> fechado, dia_fechado, próxima "amanhã às 08h"', !seg.aberto && seg.motivo === 'dia_fechado' && seg.proximaAbertura === 'amanhã às 08h', JSON.stringify(seg));
  const dom = situacao(H, em('2026-09-13T15:00:00Z'));   // domingo 11h local
  chk('domingo -> próxima "terça (15/09) às 08h" (pula a segunda)', !dom.aberto && dom.proximaAbertura === 'terça (15/09) às 08h', JSON.stringify(dom));
  const cedo = situacao(H, em('2026-09-15T10:30:00Z'));  // terça 6h30 local
  chk('terça 6h30 -> fora_da_hora, "hoje às 08h"', !cedo.aberto && cedo.motivo === 'fora_da_hora' && cedo.proximaAbertura === 'hoje às 08h', JSON.stringify(cedo));
  const tarde = situacao(H, em('2026-09-15T22:30:00Z')); // terça 18h30 local (fechou às 18)
  chk('terça 18h30 -> fora_da_hora, "amanhã às 08h"', !tarde.aberto && tarde.motivo === 'fora_da_hora' && tarde.proximaAbertura === 'amanhã às 08h', JSON.stringify(tarde));
  const aberto = situacao(H, em('2026-09-15T13:00:00Z')); // terça 9h local
  chk('terça 9h -> aberto', aberto.aberto === true && aberto.proximaAbertura === null);
  const limite = situacao(H, em('2026-09-15T21:59:00Z')); // terça 17h59 local
  chk('terça 17h59 -> aberto (fim é exclusivo às 18)', limite.aberto === true);
  const natal = situacao(H, em('2026-12-25T14:00:00Z'));  // sexta 25/12 10h local, fechado
  chk('25/12 (sexta, data fechada) -> data_fechada, próxima "amanhã às 08h" (sábado abre)', !natal.aberto && natal.motivo === 'data_fechada' && natal.proximaAbertura === 'amanhã às 08h', JSON.stringify(natal));
  const fuso = situacao(lerHorarioAgente({ ...H, timezone: 'America/Sao_Paulo' }), em('2026-09-15T10:30:00Z')); // 7h30 em SP
  chk('o fuso importa: 10:30Z é 7h30 em SP -> ainda fechado', !fuso.aberto);
  const madruga = situacao(H, em('2026-09-15T03:30:00Z')); // segunda 23h30 local!
  chk('03:30Z é segunda 23h30 em Porto Velho -> dia_fechado (o dia local decide, não o UTC)', !madruga.aberto && madruga.motivo === 'dia_fechado' && madruga.proximaAbertura === 'amanhã às 08h', JSON.stringify(madruga));
}

console.log('\n== serviço: textos ==\n');
{
  const s = situacao(H, em('2026-09-14T19:00:00Z'));
  chk('aviso padrão traz a próxima abertura', /Voltamos amanhã às 08h/.test(textoDoAviso(H, s)));
  const Hm = lerHorarioAgente({ ...H, mensagem: 'Fechado agora! Abrimos {proxima}. Deixe sua mensagem.' });
  chk('mensagem do tenant com {proxima} substituído', textoDoAviso(Hm, s) === 'Fechado agora! Abrimos amanhã às 08h. Deixe sua mensagem.', textoDoAviso(Hm, s));
  chk('linha do prompt (atender) diz FECHADA e quando abre', /FECHADA agora/.test(linhaDoPromptFechado(s)) && /volta a abrir amanhã às 08h/.test(linhaDoPromptFechado(s)));
  const d = lerHorarioAgente({ fora_horario: 'x', hora_inicio: 99, dias_semana: [1, 9, 'a'] });
  chk('leitura tolerante: postura inválida -> aviso; hora fora -> default 8; dias inválidos descartados', d.foraHorario === 'aviso' && d.horaInicio === 8 && d.diasSemana.join() === '1');
}

console.log('\n== painel: validador ==\n');
const form = (campos) => { const fd = new FormData(); for (const [k, v] of Object.entries(campos)) fd.set(k, v); return fd; };
{
  const base = { horario_ativo: 'on', timezone: 'America/Porto_Velho', dia_2: 'on', dia_3: 'on', hora_inicio: '8', hora_fim: '18', fora_horario: 'silencio', fechados: '25/12/2026\n2027-01-01, 01/01/2027' };
  const r = validarHorarioAgente(form(base));
  chk('formulário ok -> dias [2,3], datas ISO ordenadas e sem duplicata, postura silencio', r.ok && r.valor.dias_semana.join() === '2,3' && r.valor.fechados.join() === '2026-12-25,2027-01-01' && r.valor.fora_horario === 'silencio', JSON.stringify(r));
  chk('desligado -> null (sempre aberto), sem olhar o resto', validarHorarioAgente(form({ timezone: 'x' })).ok === true && validarHorarioAgente(form({ timezone: 'x' })).valor === null);
  const r2 = validarHorarioAgente(form({ ...base, fechados: '31/02/2026' }));
  chk('31/02 -> erro em fechados', !r2.ok && 'fechados' in r2.erros);
  const r3 = validarHorarioAgente(form({ ...base, hora_inicio: '18', hora_fim: '8' }));
  chk('início >= fim -> erro em hora_fim', !r3.ok && 'hora_fim' in r3.erros);
  const r4 = validarHorarioAgente(form({ horario_ativo: 'on', timezone: 'America/Porto_Velho', hora_inicio: '8', hora_fim: '18' }));
  chk('nenhum dia -> erro em dias_semana', !r4.ok && 'dias_semana' in r4.erros);
  const r5 = validarHorarioAgente(form({ ...base, mensagem: 'x'.repeat(301) }));
  chk('mensagem > 300 -> erro', !r5.ok && 'mensagem' in r5.erros);
  chk('lerDatasFechadas: BR e ISO, inválida separada', JSON.stringify(lerDatasFechadas('1/1/2027; 2026-12-25\nabc')) === JSON.stringify({ datas: ['2026-12-25', '2027-01-01'], invalidas: ['abc'] }));
  chk('datasParaExibir volta para DD/MM/AAAA', datasParaExibir(['2026-12-25']) === '25/12/2026');
  chk('lerPainel: null -> null; objeto -> defaults iguais aos do serviço', lerPainel(null) === null && lerPainel({}).hora_inicio === 8 && lerPainel({}).fora_horario === 'aviso');
}

console.log(`\n${ok} passaram, ${falhas.length} falharam\n`);
if (falhas.length) process.exit(1);
