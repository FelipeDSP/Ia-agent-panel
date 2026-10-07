/**
 * O aviso de `{{marcador}}` no prompt do cliente (07/10).
 *
 * De onde veio: o prompt da estud.you tem `{{CATALOGO_DE_CURSOS}}` e, logo
 * abaixo, "Consulte exclusivamente este catálogo". Nada substitui marcador
 * nenhum neste sistema, então o agente ficou instruído a consultar
 * exclusivamente uma lista que não existe — e em nove turnos não chamou
 * `consultar_catalogo` uma vez, enquanto o Empório chamou onze. Um cliente
 * pediu "Treinamento de NR 01" (R$ 69,90, no catálogo) e ouviu uma aula.
 *
 * Três coisas são medidas, e a terceira é a que sustenta as outras duas:
 *
 *  1. a detecção acha o que tem de achar, e não acha o que não tem;
 *  2. as duas telas que recebem prompt mostram o aviso;
 *  3. **o serviço realmente NÃO substitui nada.** O aviso diz ao cliente "o
 *     agente lê o texto entre chaves do jeito que está". Se alguém um dia
 *     puser um motor de template em `montarSystemMessage`, o aviso vira
 *     mentira — e mentira na tela é pior que silêncio. Esta asserção é o par
 *     derivado: a afirmação da tela medida contra o código que a torna
 *     verdadeira (a lição de 09/09, a propriedade certa verificada no lugar
 *     errado).
 *
 * Varredura com `split(/\r?\n/)` e comentário tirado antes do regex: 174
 * arquivos deste repo estão em CRLF, e já houve guarda que casou o próprio
 * comentário em vez do código.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { placeholdersNoPrompt, avisoDePlaceholders } from '../src/lib/tenants/placeholders.ts';
import { montarSystemMessage } from '../agente/src/agente/prompt.ts';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let ok = 0;
const falhas = [];
const chk = (nome, cond, extra = '') => {
  if (cond) { ok++; console.log(`  ok    ${nome}`); }
  else { falhas.push(nome); console.log(`  FALHA ${nome}${extra ? ' — ' + extra : ''}`); }
};

console.log('\n=== 1. A detecção ===\n');

chk('prompt limpo não acusa nada', placeholdersNoPrompt('Você é a Ana Maria, do Empório.').length === 0);
chk('...e o aviso dele é null', avisoDePlaceholders('Você é a Ana Maria, do Empório.') === null);
chk('texto vazio não quebra', placeholdersNoPrompt('').length === 0 && placeholdersNoPrompt(null).length === 0);

// O caso da estud.you, como está gravado.
const ESTUDYOU = 'Catálogo de cursos vigente:\n\n{{CATALOGO_DE_CURSOS}}\n\nConsulte exclusivamente este catálogo.\nTempo médio: {{SLA}}. Link: {{LINK_DENUNCYOU}}';
const achadosEstudyou = placeholdersNoPrompt(ESTUDYOU);
chk('acha os três marcadores da estud.you', achadosEstudyou.length === 3, achadosEstudyou.join(','));
chk('e acha o do catálogo pelo nome', achadosEstudyou.includes('CATALOGO_DE_CURSOS'));

// O caso do CEEJAAR: marcadores que são frases, com espaço, acento e pontuação.
// Se a detecção só casasse IDENTIFICADORES (`[A-Z_]+`), estes passariam batido —
// e são os de um cliente real, em produção.
const CEEJAAR = 'Custo: {{GRATUITO? HÁ TAXA?}} E-mail da secretaria: {{E-MAIL}}\n"É pago?" {{PREENCHER}}.';
const achadosCeejaar = placeholdersNoPrompt(CEEJAAR);
chk('acha marcador com espaço, acento e pontuação', achadosCeejaar.length === 3, achadosCeejaar.join(' | '));

// A armadilha do regex guloso: `[\s\S]*` casaria do primeiro `{{` ao último
// `}}` e devolveria UM achado com o prompt inteiro dentro — "detectado", e
// inútil. Dois marcadores distantes têm de sair como DOIS.
const LONGE = '{{UM}}' + 'x'.repeat(5000) + '{{DOIS}}';
const longe = placeholdersNoPrompt(LONGE);
chk('dois marcadores distantes saem como DOIS, não como um gigante', longe.length === 2 && longe[0] === 'UM' && longe[1] === 'DOIS',
  `${longe.length}: ${longe.map((x) => x.slice(0, 20)).join(',')}`);

chk('repetido conta uma vez só', placeholdersNoPrompt('{{A}} e {{A}} e {{B}}').length === 2);
chk('chave sozinha não é marcador', placeholdersNoPrompt('use { "a": 1 } no json').length === 0);
chk('{{}} vazio não é marcador', placeholdersNoPrompt('{{}} e {{   }}').length === 0);

console.log('\n=== 2. O aviso que a tela mostra ===\n');

const aviso = avisoDePlaceholders(ESTUDYOU);
chk('o aviso existe quando há marcador', typeof aviso === 'string' && aviso.length > 0);
chk('e cita o marcador pelo nome, não só a contagem', (aviso ?? '').includes('{{CATALOGO_DE_CURSOS}}'));
chk('e diz o que fazer, não só que está errado', /consultar o catálogo|enquanto não houver resposta/.test(aviso ?? ''));

// Marcador-frase do CEEJAAR é cortado para não estourar a tela, mas continua
// reconhecível.
const avisoLongo = avisoDePlaceholders('{{' + 'A'.repeat(300) + '}}');
chk('marcador gigante é cortado no aviso', (avisoLongo ?? '').length < 500, String((avisoLongo ?? '').length));

// Singular/plural: o aviso é lido por quem não escreveu o sistema.
chk('um marcador: "um marcador"', /um marcador/.test(avisoDePlaceholders('{{X}}') ?? ''));
chk('vários: a contagem', /3 marcadores/.test(aviso ?? ''));

console.log('\n=== 3. As telas que recebem prompt ===\n');

/** Código sem comentário — já houve guarda que casou o próprio comentário. */
function semComentario(fonte) {
  return fonte.split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');
}

const TELAS = [
  ['editor de prompt (cliente e agência)', path.join(RAIZ, 'src', 'components', 'prompt-editor.tsx')],
  ['cliente novo (agência)', path.join(RAIZ, 'src', 'app', '(app)', 'admin', 'tenants', 'novo', 'formulario.tsx')],
];
chk('a lista de telas não está vazia', TELAS.length > 0);
for (const [nome, arq] of TELAS) {
  const fonte = semComentario(fs.readFileSync(arq, 'utf8'));
  chk(`${nome}: chama avisoDePlaceholders`, /avisoDePlaceholders\(/.test(fonte), arq);
  // Chamar e não renderizar é o defeito que `ficha-do-cliente` já pegou uma vez:
  // import sem uso não quebra build nem tipo, e a tela perde a capacidade calada.
  chk(`${nome}: e RENDERIZA o resultado num Alert`, /aviso\w*\s*\?\s*<Alert/.test(fonte), arq);
}

console.log('\n=== 4. O par derivado: o serviço não substitui nada ===\n');

const COM_MARCADOR = 'Catálogo: {{CATALOGO_DE_CURSOS}} fim.';
const { texto } = montarSystemMessage({ perfil: 'basico', systemPromptDoTenant: COM_MARCADOR });
chk('o system message contém o marcador LITERAL, não um catálogo',
  texto.includes('{{CATALOGO_DE_CURSOS}}'),
  'se isto reprovou, alguém pôs um motor de template — e o texto do aviso virou mentira');
// Contraprova: o prompt do tenant de fato entrou. Sem ela, a asserção acima
// seria sobre um texto que podia nem conter o prompt.
chk('CONTRAPROVA: o prompt do tenant entrou mesmo no system message', texto.includes('Catálogo:') && texto.includes('fim.'));

console.log(`\n${falhas.length ? 'FALHOU' : 'passaram'}: ${ok} ok, ${falhas.length} falhas`);
if (falhas.length) { for (const f of falhas) console.log('  - ' + f); process.exit(1); }
