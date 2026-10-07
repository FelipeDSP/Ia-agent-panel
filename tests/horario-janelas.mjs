/**
 * HORÁRIO EM VÁRIAS FAIXAS (07/10) — o intervalo que não cabia na forma antiga.
 *
 * A 74 modelou o horário como UMA faixa por semana. O Empório abre ter–sex das
 * 7h às 10h e das 16h às 19h, e sáb/dom das 8h às 11h. O que estava gravado em
 * produção era a união grosseira — `dias_semana: [0,2,3,4,5,6]`, `7` às `19` —
 * e por isso **às 12h de uma quarta o agente respondia "estamos abertos"**, com
 * a loja fechada havia duas horas, e aceitava marcar retirada para um horário
 * em que não há ninguém no balcão. Não era pedido de funcionalidade: era
 * resposta errada em produção.
 *
 * O que este teste mede:
 *
 *  1. a conta SEM a chave nova não muda — a faixa legada vira uma janela, e o
 *     `teste:horario-agente` inteiro (23 asserções) continua verde por cima
 *     deste mesmo código. Aqui a derivação é afirmada de frente;
 *  2. a grade real do Empório, hora a hora, incluindo o buraco das 10h às 16h
 *     e a resposta "hoje às 16h" — que a forma antiga não tinha como dar,
 *     porque ela só sabia procurar o PRÓXIMO DIA;
 *  3. o par derivado: o painel ESCREVE e o serviço LÊ, em arquivos diferentes.
 *     Um teste que só exercitasse um lado daria a sensação de cobertura que o
 *     outro não tem (a lição de 09/09, `tests/portao-venda-afirmada.mjs`).
 *     Então o que o validador do painel produz é passado para o leitor do
 *     serviço, e as janelas têm de sobreviver à viagem.
 *
 * Nenhuma asserção usa relógio de parede: toda `situacao` recebe a data.
 */
import {
  lerHorarioAgente, situacao, secaoHorario, janelasDoDia, minutosDe, horaHumana,
} from '../agente/src/tenant/horario.ts';
import {
  lerHorarioAgente as lerPainel, validarHorarioAgente, hhmm, MAX_JANELAS,
} from '../src/lib/tenants/horario-agente.ts';

let ok = 0;
const falhas = [];
const chk = (nome, cond, extra = '') => {
  if (cond) { ok++; console.log(`  ok    ${nome}`); }
  else { falhas.push(nome); console.log(`  FALHA ${nome}${extra ? ' — ' + extra : ''}`); }
};
const em = (iso) => new Date(iso);
const form = (o) => { const fd = new FormData(); for (const [k, v] of Object.entries(o)) fd.set(k, v); return fd; };

console.log('\n=== 1. HH:MM ===\n');

chk('"07:00" -> 420', minutosDe('07:00') === 420);
chk('"7" -> 420 (hora cheia sem minuto)', minutosDe('7') === 420);
chk('7 (número) -> 420 — é assim que a chave legada chega', minutosDe(7) === 420);
chk('"24:00" -> 1440 (fim do dia é válido)', minutosDe('24:00') === 1440);
chk('"7:5" inválido (minuto tem de ter 2 dígitos)', minutosDe('7:5') === null);
chk('"25:00" inválido', minutosDe('25:00') === null);
chk('"07:60" inválido', minutosDe('07:60') === null);
chk('vazio e lixo -> null', minutosDe('') === null && minutosDe('manhã') === null && minutosDe(null) === null);
chk('420 -> "07h"; 450 -> "07h30" (minuto só aparece quando existe)', horaHumana(420) === '07h' && horaHumana(450) === '07h30');

console.log('\n=== 2. A conta de hoje não muda: a faixa legada vira UMA janela ===\n');

const LEGADO = lerHorarioAgente({ timezone: 'America/Porto_Velho', dias_semana: [2, 3, 4, 5, 6], hora_inicio: 8, hora_fim: 18, fechados: [], fora_horario: 'aviso' });
chk('sem `janelas`, nasce exatamente uma', LEGADO.janelas.length === 1);
chk('...com os dias e as horas do par legado', JSON.stringify(LEGADO.janelas[0]) === JSON.stringify({ dias: [2, 3, 4, 5, 6], inicio: 480, fim: 1080 }),
  JSON.stringify(LEGADO.janelas[0]));
chk('terça 9h local -> aberto (como antes)', situacao(LEGADO, em('2026-09-15T13:00:00Z')).aberto === true);
chk('terça 18h30 local -> fechado (como antes)', situacao(LEGADO, em('2026-09-15T22:30:00Z')).aberto === false);

// `janelas` presente mas toda inválida é como ausente — config torta não pode
// fechar a loja de quem está vendendo.
const TORTO = lerHorarioAgente({ dias_semana: [1], hora_inicio: 9, hora_fim: 17, janelas: [{ dias: [], inicio: '08:00', fim: '10:00' }, { dias: [1], inicio: '20:00', fim: '08:00' }, 'lixo'] });
chk('janelas todas inválidas -> cai no legado, não em "nunca abre"', TORTO.janelas.length === 1 && TORTO.janelas[0].inicio === 540);
chk('CONTRAPROVA: UMA janela válida no meio do lixo é respeitada',
  lerHorarioAgente({ dias_semana: [1], hora_inicio: 9, hora_fim: 17, janelas: ['lixo', { dias: [3], inicio: '14:00', fim: '15:30' }] }).janelas.length === 1
  && lerHorarioAgente({ dias_semana: [1], hora_inicio: 9, hora_fim: 17, janelas: ['lixo', { dias: [3], inicio: '14:00', fim: '15:30' }] }).janelas[0].fim === 930);

console.log('\n=== 3. A grade real do Empório ===\n');

// ter–sex 7–10 e 16–19; sáb e dom 8–11; segunda fechada; último domingo fechado.
const EMPORIO = lerHorarioAgente({
  timezone: 'America/Porto_Velho',
  dias_semana: [0, 2, 3, 4, 5, 6], hora_inicio: 7, hora_fim: 19,   // legado, como está em produção
  janelas: [
    { dias: [2, 3, 4, 5], inicio: '07:00', fim: '10:00' },
    { dias: [2, 3, 4, 5], inicio: '16:00', fim: '19:00' },
    { dias: [0, 6], inicio: '08:00', fim: '11:00' },
  ],
  fechados: ['2026-10-25'],
  fora_horario: 'atender',
});
chk('as três janelas foram lidas', EMPORIO.janelas.length === 3);
chk('quarta tem DUAS janelas, na ordem', janelasDoDia(EMPORIO, 3).map((j) => j.inicio).join() === '420,960');
chk('segunda não tem nenhuma', janelasDoDia(EMPORIO, 1).length === 0);

// Porto Velho é UTC-4. 2026-10-07 é uma quarta.
const quarta = (hhLocal) => em(`2026-10-07T${String(hhLocal + 4).padStart(2, '0')}:00:00Z`);

chk('quarta 08h -> ABERTO', situacao(EMPORIO, quarta(8)).aberto === true);
chk('quarta 09h59 -> ABERTO', situacao(EMPORIO, em('2026-10-07T13:59:00Z')).aberto === true);

// ESTE é o defeito. Antes das janelas, 12h caía dentro de 7–19 e dava "aberto".
const almoco = situacao(EMPORIO, quarta(12));
chk('quarta 12h -> FECHADO (era aqui que ele dizia "estamos abertos")', almoco.aberto === false);
chk('...e o motivo é fora_da_hora, não dia_fechado', almoco.motivo === 'fora_da_hora');
chk('...e a próxima abertura é HOJE às 16h, não amanhã', almoco.proximaAbertura === 'hoje às 16h', String(almoco.proximaAbertura));

chk('quarta 16h -> ABERTO (a segunda janela)', situacao(EMPORIO, quarta(16)).aberto === true);
chk('quarta 17h -> ABERTO', situacao(EMPORIO, quarta(17)).aberto === true);
const noite = situacao(EMPORIO, em('2026-10-07T23:30:00Z')); // quarta 19h30
chk('quarta 19h30 -> FECHADO, abre amanhã às 07h', noite.aberto === false && noite.proximaAbertura === 'amanhã às 07h', String(noite.proximaAbertura));

const domingo = situacao(EMPORIO, em('2026-10-11T13:00:00Z')); // domingo 9h
chk('domingo 09h -> ABERTO (janela do fim de semana)', domingo.aberto === true);
const domTarde = situacao(EMPORIO, em('2026-10-11T18:00:00Z')); // domingo 14h
chk('domingo 14h -> FECHADO (fim de semana fecha às 11h)', domTarde.aberto === false);
chk('...e não promete "hoje", porque não há outra janela no domingo', domTarde.proximaAbertura === 'amanhã às 07h' || !/hoje/.test(domTarde.proximaAbertura ?? ''),
  String(domTarde.proximaAbertura));

const segunda = situacao(EMPORIO, em('2026-10-12T13:00:00Z'));
chk('segunda -> dia_fechado', segunda.aberto === false && segunda.motivo === 'dia_fechado');
chk('...e a próxima é terça às 07h', /às 07h/.test(segunda.proximaAbertura ?? ''), String(segunda.proximaAbertura));

const ultimoDom = situacao(EMPORIO, em('2026-10-25T13:00:00Z')); // 9h, dentro da janela, mas data fechada
chk('último domingo do mês (data cadastrada) -> data_fechada mesmo dentro da janela',
  ultimoDom.aberto === false && ultimoDom.motivo === 'data_fechada');

// O MINUTO conta. Esta seção nasceu de uma sabotagem que passou: eu havia
// trocado as horas cheias pelo minuto no código, mas TODAS as asserções acima
// caem em hora cheia — descartar o minuto do relógio deixava a suíte verde.
// Meia hora é comum em comércio (a secretaria do CEEJAAR abre 7h30), e sem
// isto o modelo diria "aberto" às 7h de uma loja que abre 7h30.
const MEIA = lerHorarioAgente({
  timezone: 'America/Porto_Velho',
  janelas: [{ dias: [3], inicio: '07:30', fim: '11:30' }],
  fora_horario: 'atender',
});
chk('07h00 numa loja que abre 07h30 -> FECHADO', situacao(MEIA, em('2026-10-07T11:00:00Z')).aberto === false);
chk('...e a próxima é hoje às 07h30 (com o minuto)', situacao(MEIA, em('2026-10-07T11:00:00Z')).proximaAbertura === 'hoje às 07h30',
  String(situacao(MEIA, em('2026-10-07T11:00:00Z')).proximaAbertura));
chk('07h29 -> ainda FECHADO', situacao(MEIA, em('2026-10-07T11:29:00Z')).aberto === false);
chk('07h30 -> ABERTO (o minuto exato abre)', situacao(MEIA, em('2026-10-07T11:30:00Z')).aberto === true);
chk('11h29 -> ABERTO', situacao(MEIA, em('2026-10-07T15:29:00Z')).aberto === true);
chk('11h30 -> FECHADO (o fim é exclusivo, no minuto)', situacao(MEIA, em('2026-10-07T15:30:00Z')).aberto === false);
chk('a grade do prompt mostra o minuto', /quarta: 07h30–11h30/.test(secaoHorario(MEIA, situacao(MEIA, em('2026-10-07T11:00:00Z')))));

console.log('\n=== 4. A grade que vai ao prompt ===\n');

const sec = secaoHorario(EMPORIO, almoco);
chk('agrupa dias consecutivos de grade igual', /terça a sexta: 07h–10h e 16h–19h/.test(sec), sec);
chk('o fim de semana sai junto', /sábado a domingo: 08h–11h/.test(sec), sec);
chk('segunda aparece como fechado', /segunda: fechado/.test(sec), sec);
chk('diz o estado AGORA e quando abre', /AGORA a loja está FECHADA\. Abre hoje às 16h\./.test(sec), sec);
chk('aberto diz ABERTA', /AGORA a loja está ABERTA/.test(secaoHorario(EMPORIO, situacao(EMPORIO, quarta(8)))));
chk('proíbe inventar horário', /Nunca invente horário/.test(sec));
// Contraprova de agrupamento: com grade diferente por dia, NÃO agrupa.
const variado = lerHorarioAgente({ janelas: [{ dias: [1], inicio: '08:00', fim: '12:00' }, { dias: [2], inicio: '09:00', fim: '13:00' }] });
chk('CONTRAPROVA: grades diferentes não são agrupadas', /- segunda: 08h–12h/.test(secaoHorario(variado, situacao(variado, quarta(8)))) && /- terça: 09h–13h/.test(secaoHorario(variado, situacao(variado, quarta(8)))));

console.log('\n=== 5. O painel escreve, o serviço lê ===\n');

const base = { horario_ativo: 'on', timezone: 'America/Porto_Velho', fora_horario: 'atender', fechados: '25/10/2026' };
const JANELAS_EMPORIO = JSON.stringify([
  { dias: [2, 3, 4, 5], inicio: '07:00', fim: '10:00' },
  { dias: [2, 3, 4, 5], inicio: '16:00', fim: '19:00' },
  { dias: [0, 6], inicio: '08:00', fim: '11:00' },
]);
const salvo = validarHorarioAgente(form({ ...base, janelas: JANELAS_EMPORIO }));
chk('o formulário com janelas é aceito', salvo.ok === true, JSON.stringify(salvo.erros ?? {}));
// `?.length` e nao `.length`: sem a chave gravada isto estourava e matava as
// secoes 5 e 6 inteiras — rejeicao inesperada tem de virar FALHA, nao crash,
// senao nao se sabe QUAL propriedade quebrou (CLAUDE.md, secao de testes).
chk('as três janelas são gravadas', (salvo.ok && salvo.valor.janelas?.length) === 3,
  'janelas: ' + JSON.stringify(salvo.ok ? salvo.valor.janelas : null));
// Os legados são DERIVADOS, não lidos do form — o form nem os mandou.
chk('dias_semana derivado = união dos dias', (salvo.ok && salvo.valor.dias_semana?.join()) === '0,2,3,4,5,6', JSON.stringify(salvo.ok && salvo.valor.dias_semana));
chk('hora_inicio derivada = a mais cedo (7)', salvo.ok && salvo.valor.hora_inicio === 7);
chk('hora_fim derivada = a mais tarde (19)', salvo.ok && salvo.valor.hora_fim === 19);

// O PAR: o que o painel gravou, lido pelo SERVIÇO, tem de decidir igual.
const ida = lerHorarioAgente(salvo.ok ? salvo.valor : {});
chk('o serviço lê as 3 janelas que o painel gravou', ida.janelas?.length === 3, JSON.stringify(ida.janelas));
chk('e decide igual no caso que motivou tudo: quarta 12h fechado, abre hoje às 16h',
  situacao(ida, quarta(12)).aberto === false && situacao(ida, quarta(12)).proximaAbertura === 'hoje às 16h');
chk('e o leitor do PAINEL devolve as mesmas janelas (ida e volta)',
  JSON.stringify(lerPainel(salvo.ok ? salvo.valor : {})?.janelas ?? null) === JANELAS_EMPORIO,
  JSON.stringify(lerPainel(salvo.ok ? salvo.valor : {})?.janelas ?? null));

console.log('\n=== 6. O que o painel recusa ===\n');

const ruim = (j) => validarHorarioAgente(form({ ...base, janelas: j }));
chk('lista vazia -> erro', ruim('[]').ok === false);
chk('JSON quebrado -> erro, não exceção', ruim('[{').ok === false);
chk('faixa sem dia -> erro que diz QUAL faixa', (() => { const r = ruim(JSON.stringify([{ dias: [], inicio: '08:00', fim: '10:00' }])); return r.ok === false && /Faixa 1.*dia/.test(r.erros.janelas ?? ''); })());
chk('fim <= início -> erro', (() => { const r = ruim(JSON.stringify([{ dias: [1], inicio: '18:00', fim: '08:00' }])); return r.ok === false && /Faixa 1/.test(r.erros.janelas ?? ''); })());
chk('hora inválida -> erro', ruim(JSON.stringify([{ dias: [1], inicio: '25:00', fim: '26:00' }])).ok === false);
chk(`mais de ${MAX_JANELAS} faixas -> erro`, ruim(JSON.stringify(Array.from({ length: MAX_JANELAS + 1 }, () => ({ dias: [1], inicio: '08:00', fim: '09:00' })))).ok === false);
chk('a segunda faixa torta também é pega (não só a primeira)', (() => {
  const r = ruim(JSON.stringify([{ dias: [1], inicio: '08:00', fim: '10:00' }, { dias: [2], inicio: '10:00', fim: '09:00' }]));
  return r.ok === false && /Faixa 2/.test(r.erros.janelas ?? '');
})());

// O formulário ANTIGO (sem `janelas`) continua aceito e vira uma faixa.
const antigo = validarHorarioAgente(form({ ...base, dia_2: 'on', dia_3: 'on', hora_inicio: '8', hora_fim: '18' }));
chk('formulário sem `janelas` ainda é aceito', antigo.ok === true, JSON.stringify(antigo.erros ?? {}));
chk('...e produz uma faixa equivalente', (antigo.ok && antigo.valor.janelas?.length) === 1 && antigo.valor.janelas[0].inicio === '08:00' && antigo.valor.janelas[0].dias.join() === '2,3');
chk('hhmm fecha o par com minutosDe', hhmm(minutosDe('07:30')) === '07:30');

console.log(`\n${falhas.length ? 'FALHOU' : 'passaram'}: ${ok} ok, ${falhas.length} falhas`);
if (falhas.length) { for (const f of falhas) console.log('  - ' + f); process.exit(1); }
