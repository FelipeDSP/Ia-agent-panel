#!/usr/bin/env node
/**
 * A LISTA DE CLIENTES DA AGÊNCIA (11/11) — o que ela passou a responder.
 *
 * Ela mostrava documentos e conversas ACUMULADOS desde sempre e um selo
 * "ativo" repetido em onze linhas. Com isso um cliente conectado e parado há
 * um mês era indistinguível de um que atendeu hoje de manhã — e quando o
 * Felipe pediu "como as contas têm se saído", em 19/10, a resposta saiu de SQL
 * escrito à mão porque a tela não tinha.
 *
 * O que este teste mede é a REGRA, não a tabela: a situação de uma conta e a
 * agregação da janela. Tudo puro, exercitado de verdade — nada de ler o fonte.
 *
 *   npm run teste:panorama
 */
import {
  DIAS_PARADO, situacaoDaConta, tempoRelativo,
} from '../src/lib/tenants/situacao.ts';
import { filtrarPanorama, ordenarPanorama } from '../src/lib/tenants/panorama.ts';

let ok = 0;
const falhas = [];
const chk = (nome, cond, det = '') => {
  if (cond) { ok++; console.log(`  ok    ${nome}`); }
  else { falhas.push(nome); console.log(`  FALHA ${nome}${det ? ' - ' + det : ''}`); }
};

const AGORA = new Date('2026-11-11T12:00:00Z');
const diasAtras = (n) => new Date(AGORA.getTime() - n * 86_400_000);
const conta = (p = {}) => ({ ativo: true, agenteAtivo: true, temChatwoot: true, ultimaAtividade: diasAtras(1), ...p });

console.log('\n=== 1. A situação da conta ===\n');

chk('conta atendendo', situacaoDaConta(conta(), AGORA).chave === 'ativo');
chk('conta suspensa pela agência', situacaoDaConta(conta({ ativo: false }), AGORA).chave === 'suspenso');
chk('agente desligado', situacaoDaConta(conta({ agenteAtivo: false }), AGORA).chave === 'agente_desligado');
chk('sem Chatwoot', situacaoDaConta(conta({ temChatwoot: false }), AGORA).chave === 'nao_conectado');
chk('conectada e nunca atendeu', situacaoDaConta(conta({ ultimaAtividade: null }), AGORA).chave === 'nunca_atendeu');

/*
 * O CASO QUE A TELA ESCONDIA. Antes, esta conta aparecia como "ativo" — igual
 * à que atendeu hoje. É o cliente que paga e não é atendido, e a agência só
 * descobria quando ele reclamava.
 */
const parada = situacaoDaConta(conta({ ultimaAtividade: diasAtras(30) }), AGORA);
chk('conectada, ligada e PARADA há 30 dias', parada.chave === 'parado', JSON.stringify(parada));
chk('...e o rótulo diz quantos dias', /30 dias/.test(parada.rotulo), parada.rotulo);
chk('...e ela é ALERTA: estava funcionando e silenciou', parada.gravidade === 'alerta', parada.gravidade);

/*
 * "NUNCA COMEÇOU" NÃO É ALARME, e isto veio de ver a tela: com `não
 * conectado` contando como alerta, o cabeçalho anunciou "8 pedem atenção"
 * numa agência com quatro clientes atendendo e zero problemas — os oito eram
 * tenants de teste e contas recém-criadas. Alarme que conta o que não é
 * alarme ensina a ignorar o alarme.
 */
chk('"não conectado" é NEUTRO (implantação pendente, não incidente)',
  situacaoDaConta(conta({ temChatwoot: false }), AGORA).gravidade === 'neutro');
chk('"nunca atendeu" também é neutro',
  situacaoDaConta(conta({ ultimaAtividade: null }), AGORA).gravidade === 'neutro');
chk('CONTRAPROVA: suspenso e agente desligado continuam ERRO',
  situacaoDaConta(conta({ ativo: false }), AGORA).gravidade === 'erro'
  && situacaoDaConta(conta({ agenteAtivo: false }), AGORA).gravidade === 'erro');

console.log('\n--- a borda dos dias ---\n');
chk(`${DIAS_PARADO - 1} dias ainda é atendendo`,
  situacaoDaConta(conta({ ultimaAtividade: diasAtras(DIAS_PARADO - 1) }), AGORA).chave === 'ativo');
chk(`${DIAS_PARADO} dias já é parado`,
  situacaoDaConta(conta({ ultimaAtividade: diasAtras(DIAS_PARADO) }), AGORA).chave === 'parado');

console.log('\n--- a ordem dos testes é a ordem da gravidade ---\n');
/*
 * Uma conta suspensa E sem Chatwoot E parada tem de dizer "suspenso": é o que
 * explica todo o resto. Dizer "parado há 30 dias" de uma conta desligada pela
 * agência culpa o cliente por uma decisão nossa.
 */
chk('suspensa ganha de tudo',
  situacaoDaConta({ ativo: false, agenteAtivo: false, temChatwoot: false, ultimaAtividade: null }, AGORA).chave === 'suspenso');
chk('agente desligado ganha de "não conectado"',
  situacaoDaConta({ ativo: true, agenteAtivo: false, temChatwoot: false, ultimaAtividade: null }, AGORA).chave === 'agente_desligado');
chk('"não conectado" ganha de "parado" (sem caixa não chega mensagem)',
  situacaoDaConta({ ativo: true, agenteAtivo: true, temChatwoot: false, ultimaAtividade: diasAtras(90) }, AGORA).chave === 'nao_conectado');

console.log('\n=== 2. O tempo relativo ===\n');

chk('nunca', tempoRelativo(null, AGORA) === 'nunca');
chk('minutos', tempoRelativo(new Date(AGORA.getTime() - 20 * 60_000), AGORA) === 'há 20 min');
chk('horas', tempoRelativo(new Date(AGORA.getTime() - 3 * 3_600_000), AGORA) === 'há 3 h');
chk('ontem', tempoRelativo(diasAtras(1), AGORA) === 'ontem', tempoRelativo(diasAtras(1), AGORA));
chk('dias', tempoRelativo(diasAtras(5), AGORA) === 'há 5 dias');
chk('meses', /m[êe]s|meses/.test(tempoRelativo(diasAtras(70), AGORA)), tempoRelativo(diasAtras(70), AGORA));

console.log('\n=== 3. A ordem da lista: quem precisa de atenção primeiro ===\n');

const linha = (nome, p = {}) => ({
  id: nome, slug: nome.toLowerCase(), nome, ativo: true, agenteAtivo: true,
  chatwootAccountId: 1, chatwootInboxId: 1, criadoEm: '2026-01-01',
  conversas7d: 0, turnos7d: 0, falhas7d: 0, ultimaAtividade: diasAtras(1),
  ultimaAtividadeTexto: 'ontem', custoMesUsd: 0, custoMesTexto: '—',
  situacao: situacaoDaConta(conta(), AGORA), ...p,
});

const movimentado = linha('Movimentado', { conversas7d: 50 });
const comFalha = linha('ComFalha', { conversas7d: 2, falhas7d: 1 });
const suspensa = linha('Suspensa', { ativo: false, situacao: situacaoDaConta(conta({ ativo: false }), AGORA) });
const quieta = linha('Quieta', { conversas7d: 1 });

/*
 * O CASO QUE A TELA MOSTROU: uma conta nunca ligada não pode empurrar para
 * baixo quem está atendendo. Na primeira versão os quatro clientes de verdade
 * ficaram no rodapé, abaixo de tenants de teste.
 */
const naoLigada = linha('NuncaLigada', { situacao: situacaoDaConta(conta({ temChatwoot: false }), AGORA) });
const ordem = ordenarPanorama([naoLigada, movimentado, quieta, suspensa, comFalha]).map((l) => l.nome);
chk('quem tem FALHA vem primeiro — é cliente sem resposta agora',
  ordem[0] === 'ComFalha', ordem.join(' > '));
chk('depois quem está fora do ar', ordem[1] === 'Suspensa', ordem.join(' > '));
chk('e entre os saudáveis, o mais movimentado', ordem[2] === 'Movimentado', ordem.join(' > '));
chk('quem NUNCA foi ligada vai para o fim, abaixo de quem atende',
  ordem[ordem.length - 1] === 'NuncaLigada', ordem.join(' > '));
chk('...e isso vale mesmo ela tendo zero conversas como a "Quieta"',
  ordem.indexOf('Quieta') < ordem.indexOf('NuncaLigada'), ordem.join(' > '));
// CONTRAPROVA: sem a regra, a ordem seria a de entrada ou a alfabética. Esta
// asserção falha se alguém trocar por `localeCompare` puro.
chk('CONTRAPROVA: a ordem NÃO é alfabética',
  ordem.join(',') !== [...ordem].sort((a, b) => a.localeCompare(b)).join(','), ordem.join(' > '));

console.log('\n=== 4. A busca ===\n');

const todas = [linha('Empório Leite Franco', { slug: 'emporio' }), linha('CEEJAAR', { slug: 'ceejaar' })];
chk('acha pelo nome', filtrarPanorama(todas, 'leite').length === 1);
chk('acha pelo slug', filtrarPanorama(todas, 'ceej').length === 1);
/*
 * OS DOIS SENTIDOS, e o segundo veio de uma sabotagem que passou. Eu só
 * afirmava "digitar SEM acento acha o nome COM acento" — e isso continua
 * verdadeiro mesmo quando a normalização do TERMO é removida, porque o lado
 * do nome ainda é normalizado. Metade da regra media metade de si mesma.
 */
chk('ignora acento: "emporio" acha "Empório"', filtrarPanorama(todas, 'emporio').length === 1);
chk('...e "empório" também acha (o termo é normalizado)',
  filtrarPanorama(todas, 'empório').length === 1, 'digitar com acento deixou de achar');
chk('ignora caixa', filtrarPanorama(todas, 'CEEJAAR').length === 1);
chk('termo vazio devolve tudo', filtrarPanorama(todas, '   ').length === 2);
chk('termo sem resultado devolve nada', filtrarPanorama(todas, 'zzz').length === 0);

console.log(`\n${falhas.length ? 'FALHOU' : 'passaram'}: ${ok} ok, ${falhas.length} falhas`);
if (falhas.length) { for (const f of falhas) console.log('  - ' + f); process.exit(1); }
