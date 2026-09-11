#!/usr/bin/env node
/**
 * teste:asaas-classificacao — a sonda sabe distinguir "o link não vale mais" de
 * "a chamada falhou".
 *
 * ---------------------------------------------------------------------------
 * A EXIGÊNCIA QUE ESTE ARQUIVO ATENDE, literal:
 *
 *   "Uma sonda que imprime «recusou o pagamento» porque a requisição falhou por
 *    OUTRO motivo — valor, formato, campo faltando — parece resposta e não é.
 *    Separe (...). Prove que consegue distinguir os dois: force um erro de valor
 *    e confirme que a sonda NÃO o classifica como link expirado."
 *
 * Ele roda na SUÍTE, sem rede e sem credencial, porque a prova não pode
 * depender de criar objeto no Asaas — e porque uma prova que só existe dentro
 * da sonda só é vista por quem roda a sonda.
 *
 * ---------------------------------------------------------------------------
 * AS FIXTURES SÃO RESPOSTAS REAIS. O 400 de três erros é o corpo literal que o
 * sandbox devolveu em 10/09/2026, na primeira execução — a que morreu. A recusa
 * virou fixture: é o caso exato que não pode ser lido como "link expirado".
 *
 * Uso: npm run teste:asaas-classificacao
 */
import {
  classificarLinkDepoisDoPrazo,
  classificarPaginaPublica,
  classificarRespostaApi,
  redigir,
  VALIDACOES_CONHECIDAS,
} from '../scripts/lib/asaas.mjs';

let ok = 0;
let falhas = 0;
const chk = (nome, cond, det) => {
  if (cond) { ok++; console.log('  OK    ' + nome); }
  else { falhas++; console.log('  FALHA ' + nome + (det ? ' — ' + det : '')); }
};

// ---------------------------------------------------------------------------
console.log('\n== 1. O erro de VALOR não é veredito sobre o link ==\n');
// ---------------------------------------------------------------------------
// A resposta real do sandbox, verbatim.
const QUATROCENTOS_REAL = {
  status: 400,
  json: {
    errors: [
      { code: 'invalid_action', description: VALIDACOES_CONHECIDAS[0] },
      { code: 'invalid_action', description: VALIDACOES_CONHECIDAS[1] },
      { code: 'invalid_action', description: VALIDACOES_CONHECIDAS[2] },
    ],
  },
};
{
  const r = classificarRespostaApi(QUATROCENTOS_REAL);
  chk('o 400 real vira `falha_de_chamada`', r.classe === 'falha_de_chamada', r.classe);
  chk('e NÃO vira `link_indisponivel`', r.classe !== 'link_indisponivel', r.classe);
  chk('e NÃO vira `ok`', r.classe !== 'ok', r.classe);
  chk('os três erros chegam inteiros a quem lê', r.erros.length === 3, String(r.erros.length));
  chk('inclusive o do valor mínimo', r.erros.some((e) => /R\$ 5,00/.test(e)));
}
{
  // O erro de valor SOZINHO — que é o que "force um erro de valor" pede.
  const r = classificarRespostaApi({
    status: 400,
    json: { errors: [{ code: 'invalid_action', description: VALIDACOES_CONHECIDAS[0] }] },
  });
  chk('erro de valor sozinho -> `falha_de_chamada`', r.classe === 'falha_de_chamada', r.classe);
  chk('  ...e em nenhuma hipótese `link_indisponivel`', r.classe !== 'link_indisponivel');
}

// ---------------------------------------------------------------------------
console.log('\n== 2. As outras classes ==\n');
// ---------------------------------------------------------------------------
chk('2xx -> ok', classificarRespostaApi({ status: 200, json: { id: 'pl_1' } }).classe === 'ok');
chk('401 -> autenticacao', classificarRespostaApi({ status: 401, json: {} }).classe === 'autenticacao');
chk('404 -> nao_encontrado (que NÃO é "expirou")',
  classificarRespostaApi({ status: 404, json: {} }).classe === 'nao_encontrado');
chk('500 -> indeterminado', classificarRespostaApi({ status: 500, json: {} }).classe === 'indeterminado');
chk('400 sem corpo reconhecível -> indeterminado, não um palpite',
  classificarRespostaApi({ status: 400, json: null }).classe === 'indeterminado');

// ---------------------------------------------------------------------------
console.log('\n== 3. A página pública ==\n');
// ---------------------------------------------------------------------------
chk('página com "expirado" -> link_indisponivel',
  classificarPaginaPublica({ status: 200, html: '<p>Este link de pagamento está expirado.</p>' })
    .classe === 'link_indisponivel');
chk('e com acento também ("indisponível")',
  classificarPaginaPublica({ status: 200, html: '<p>Cobrança indisponível</p>' })
    .classe === 'link_indisponivel');
chk('página oferecendo Pix -> pagavel',
  classificarPaginaPublica({ status: 200, html: '<button>Copiar código Pix</button>' })
    .classe === 'pagavel');
chk('404 -> link_indisponivel', classificarPaginaPublica({ status: 404, html: '' }).classe === 'link_indisponivel');

// ---------------------------------------------------------------------------
// O CASO QUE A SONDA ERROU, E QUE SÓ O NAVEGADOR RESOLVEU
// ---------------------------------------------------------------------------
// Em 10/09/2026 a sonda deu `pagavel` para um link comprovadamente desativado
// (`active:false` relido da API). Abrir a URL no navegador mostrou a frase real:
//
//   "Seu fornecedor desabilitou esse link de pagamento."
//
// A SPA do Asaas serve "pix", "boleto" e "qr code" no esqueleto mesmo quando o
// link não vale. Este é o caso literal, e ele é a razão de a lista de recusa ser
// avaliada ANTES da lista de oferta.
{
  const htmlReal = 'Sonda visual Valor R$ 5,00 (somente à vista) '
    + 'Seu fornecedor desabilitou esse link de pagamento. '
    + 'Resumo Nome Forma de pagamento Pix boleto QR Code';
  const r = classificarPaginaPublica({ status: 200, html: htmlReal });
  chk('a página de link DESABILITADO -> link_indisponivel', r.classe === 'link_indisponivel', r.classe);
  chk('  ...mesmo tendo "pix", "boleto" e "qr code" no HTML',
    r.pagavel.length > 0 && r.classe === 'link_indisponivel',
    `pagavel=[${r.pagavel}] classe=${r.classe}`);
  // A CONTRAPROVA de que a ordem é o que resolve: sem a frase de recusa, o
  // MESMO HTML vira `pagavel`. Se ele já fosse `link_indisponivel` sem ela, a
  // asserção acima estaria passando por outro motivo.
  const semFrase = classificarPaginaPublica({
    status: 200, html: htmlReal.replace('Seu fornecedor desabilitou esse link de pagamento.', ''),
  });
  chk('  ...e sem a frase o mesmo HTML vira `pagavel` (é a ORDEM que resolve)',
    semFrase.classe === 'pagavel', semFrase.classe);
}

// O caso que separa esta sonda de uma que se engana sozinha: HTML sem pista
// nenhuma (SPA que monta por JavaScript) NÃO é "pagável".
{
  const r = classificarPaginaPublica({ status: 200, html: '<div id="root"></div>' });
  chk('HTML sem pista NÃO vira "pagavel"', r.classe !== 'pagavel', r.classe);
  chk('  ...vira `indeterminado`, que é resultado e não falha', r.classe === 'indeterminado', r.classe);
}
// E o espelho: se ele nunca dissesse "pagavel", tudo acima passaria também.
chk('ESPELHO: existe caso em que ele DIZ pagavel',
  classificarPaginaPublica({ status: 200, html: 'escolha a forma de pagamento: Pix ou boleto' })
    .classe === 'pagavel');

// ---------------------------------------------------------------------------
console.log('\n== 3b. O link depois do prazo, pela API — as três coisas separadas ==\n');
// ---------------------------------------------------------------------------
// A sonda B lê o link pela API no dia seguinte ao `endDate`. Ela tem de separar
// "expirou e recusa", "expirou e aceita" e "a chamada falhou" — e o enunciado
// mandou provar que erro de valor NÃO vira expiração.
{
  const END = '2026-09-11';
  // `Date` do servidor em UTC. 03:00Z de 12/09 é 00:00 em Brasília: o dia virou.
  const virou = 'Sat, 12 Sep 2026 03:00:00 GMT';
  // 02:00Z de 12/09 é 23:00 de 11/09 em Brasília: o dia NÃO virou lá ainda.
  const naoVirou = 'Sat, 12 Sep 2026 02:00:00 GMT';
  const link = (extra) => ({ status: 200, json: { id: 'pl_x', active: true, deleted: false, endDate: END, ...extra } });

  const recusa = classificarLinkDepoisDoPrazo({ leitura: link({ active: false }), endDate: END, dataServidor: virou });
  chk('dia virou + active:false -> expirou_recusa', recusa.classe === 'expirou_recusa', recusa.classe);

  const aceita = classificarLinkDepoisDoPrazo({ leitura: link({}), endDate: END, dataServidor: virou });
  chk('dia virou + active:true -> expirou_aceita', aceita.classe === 'expirou_aceita', aceita.classe);

  const removido = classificarLinkDepoisDoPrazo({ leitura: link({ deleted: true }), endDate: END, dataServidor: virou });
  chk('dia virou + deleted:true -> expirou_recusa', removido.classe === 'expirou_recusa', removido.classe);

  // O RELÓGIO DO ASAAS, NÃO O DA MÁQUINA. Entre 21h e 00h de Brasília o UTC já
  // está no dia seguinte; sem converter, a sonda diria "virou" sem ter virado e
  // chamaria um link válido de "aceita depois de expirar".
  const cedo = classificarLinkDepoisDoPrazo({ leitura: link({}), endDate: END, dataServidor: naoVirou });
  chk('02:00Z (= 23:00 em Brasília do dia do endDate) -> ainda_no_prazo, NÃO "aceita"',
    cedo.classe === 'ainda_no_prazo', cedo.classe);
  chk('  ...e o motivo diz que dia é no Asaas', /2026-09-11/.test(cedo.motivo), cedo.motivo);

  // AS FALHAS DE CHAMADA — nenhuma vira expiração. É a exigência literal.
  const quatrocentos = classificarLinkDepoisDoPrazo({ leitura: QUATROCENTOS_REAL, endDate: END, dataServidor: virou });
  chk('erro de VALOR (o 400 real) -> falha_de_chamada, NUNCA expirou_*',
    quatrocentos.classe === 'falha_de_chamada', quatrocentos.classe);
  const naoAchou = classificarLinkDepoisDoPrazo({ leitura: { status: 404, json: {} }, endDate: END, dataServidor: virou });
  chk('404 -> falha_de_chamada (id errado não é "expirou e removeu")',
    naoAchou.classe === 'falha_de_chamada', naoAchou.classe);
  const semAuth = classificarLinkDepoisDoPrazo({ leitura: { status: 401, json: {} }, endDate: END, dataServidor: virou });
  chk('401 -> falha_de_chamada', semAuth.classe === 'falha_de_chamada', semAuth.classe);

  const semData = classificarLinkDepoisDoPrazo({ leitura: link({}), endDate: END, dataServidor: null });
  chk('sem header Date -> indeterminado (não sei que dia é lá)', semData.classe === 'indeterminado', semData.classe);
  const semActive = classificarLinkDepoisDoPrazo({ leitura: { status: 200, json: { id: 'x' } }, endDate: END, dataServidor: virou });
  chk('200 sem `active` -> indeterminado, não um palpite', semActive.classe === 'indeterminado', semActive.classe);
}

// ---------------------------------------------------------------------------
console.log('\n== 4. A chave nunca sai impressa ==\n');
// ---------------------------------------------------------------------------
// O `x-foto-secret` deste projeto vazou três vezes por estar onde alguém
// imprimiu ou exportou. Uma chave que movimenta dinheiro não repete isso.
{
  // A FIXTURE É CONSTRUÍDA PARA NÃO PODER COINCIDIR COM CHAVE NENHUMA, e isso
  // não é excesso de zelo: a primeira versão desta linha tinha uma "chave falsa"
  // que eu digitei achando que era inventada, e ela começava com os **30
  // primeiros caracteres da chave real**. Foi pega pela varredura da §5 antes de
  // ir para o git — por pouco, e por varredura, não por leitura.
  const falsa = '$aact_' + 'hmlg_' + 'FIXTURE'.repeat(6) + '==';
  const texto = `erro ao chamar com access_token=${falsa} no header`;
  const limpo = redigir(texto);
  chk('a redação tira a chave', !limpo.includes(falsa), limpo);
  chk('e deixa marca de que havia algo ali', /REDIGIDO/.test(limpo), limpo);
  chk('e não come o resto do texto', limpo.includes('erro ao chamar') && limpo.includes('no header'));
  chk('texto sem chave passa intacto', redigir('nada aqui') === 'nada aqui');
}

// ---------------------------------------------------------------------------
console.log('\n== 5. Nenhum arquivo VERSIONADO carrega pedaço da chave ==\n');
// ---------------------------------------------------------------------------
// Esta seção não é hipotética: ela pegou um vazamento de verdade em 10/09/2026.
// A "chave falsa" da §4 tinha sido digitada de cabeça e começava com os 30
// primeiros caracteres da chave de sandbox real. O arquivo ainda não estava no
// git; o que impediu foi a varredura, não a leitura.
//
// O `x-foto-secret` deste projeto já vazou TRÊS vezes por estar em lugar que
// ninguém varria. Uma chave que movimenta dinheiro entra na varredura desde o
// primeiro dia.
{
  const { execFileSync } = await import('node:child_process');
  const fs2 = await import('node:fs');
  const chave = process.env.ASAAS_SANDBOX_KEY ?? null;

  if (!chave) {
    // Sem a chave não dá para varrer, e "passou" seria vácuo. Vira AVISO, não
    // verde: quem roda sem `--env-file` fica sabendo que esta prova não rodou.
    console.log('  AVISO sem ASAAS_SANDBOX_KEY no ambiente — a varredura NÃO rodou.');
    console.log('        (rode `npm run teste`, que passa --env-file, para exercitá-la)');
  } else {
    // 24 caracteres: longo o bastante para não colidir por acaso com base64
    // qualquer, curto o bastante para pegar um pedaço colado sem querer.
    const N = 24;
    const pedacos = [];
    for (let i = 0; i + N <= chave.length; i += 8) pedacos.push(chave.slice(i, i + N));

    const arquivos = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
      .split(/\r?\n/).filter(Boolean);
    const sujos = [];
    for (const f of arquivos) {
      let t;
      try { t = fs2.readFileSync(f, 'utf8'); } catch { continue; }
      if (pedacos.some((p) => t.includes(p))) sujos.push(f);
    }
    chk(`nenhum dos ${arquivos.length} arquivos versionados contém ${N}+ chars da chave`,
      sujos.length === 0, sujos.join(', '));

    // CONTRAPROVA: a varredura ACHA quando há o que achar. Sem ela, um bug que
    // fizesse `pedacos` sair vazio deixaria tudo verde para sempre — que é
    // exatamente a asserção vácua do injetor do portão, em 09/09.
    chk('CONTRAPROVA: a varredura encontra a chave num texto que a contém',
      pedacos.length > 0 && pedacos.some((p) => `prefixo ${chave} sufixo`.includes(p)),
      `${pedacos.length} pedaços`);
    // E o `.env.local`, que é onde ela DEVE estar, não é versionado.
    chk('`.env.local` não está entre os arquivos versionados',
      !arquivos.includes('.env.local'));
  }
}

// ---------------------------------------------------------------------------
console.log('\n== 6. SABOTAGEM: o classificador virando otimista ==\n');
// ---------------------------------------------------------------------------
// Não dá para sabotar o módulo já importado, então a sabotagem é sobre o
// ARQUIVO: muta, confirma que a mutação ENTROU pelo md5, recarrega e exige que
// a asserção do §1 quebre.
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  const crypto = await import('node:crypto');
  const { fileURLToPath } = await import('node:url');
  const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const ARQ = path.join(RAIZ, 'scripts', 'lib', 'asaas.mjs');
  const md5 = (t) => crypto.createHash('md5').update(t, 'utf8').digest('hex').slice(0, 12);

  const original = fs.readFileSync(ARQ, 'utf8');
  const alvo = "      classe: ehValidacao ? 'falha_de_chamada' : 'indeterminado',";
  const n = original.split(alvo).length - 1;

  if (n !== 1) {
    falhas++;
    console.log(`  FALHA a sabotagem casa ${n}x, esperava 1 — o alvo mudou de forma`);
  } else {
    const mutado = original.split(alvo).join(
      "      classe: ehValidacao ? 'link_indisponivel' : 'indeterminado',");
    fs.writeFileSync(ARQ, mutado);
    const relido = fs.readFileSync(ARQ, 'utf8');
    // md5, não tamanho: 'falha_de_chamada' e 'link_indisponivel' têm
    // comprimentos parecidos e o tamanho é sinal fraco.
    chk('a sabotagem ENTROU no arquivo', relido !== original,
      `md5 ${md5(original)} -> ${md5(relido)}`);

    let classeSabotada = null;
    try {
      const url = new URL('../scripts/lib/asaas.mjs', import.meta.url);
      url.searchParams.set('v', String(Date.now()));   // fura o cache de módulos
      const mod = await import(url.href);
      classeSabotada = mod.classificarRespostaApi(QUATROCENTOS_REAL).classe;
    } finally {
      fs.writeFileSync(ARQ, original);
      chk('o arquivo foi restaurado byte a byte',
        fs.readFileSync(ARQ, 'utf8') === original);
    }

    chk('SABOTAGEM -> o erro de VALOR passaria por "link indisponível"',
      classeSabotada === 'link_indisponivel', String(classeSabotada));
  }
}

console.log(`\n${'-'.repeat(60)}`);
console.log(`  ${ok} passaram, ${falhas} falharam`);
process.exit(falhas ? 1 : 0);
