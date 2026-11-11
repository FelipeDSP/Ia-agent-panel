#!/usr/bin/env node
/**
 * ENTRAR NA CONTA DO CLIENTE (11/11) — o que impede isso de virar escada.
 *
 * A funcionalidade é: um super_admin entra no painel de um cliente para
 * arrumar algo para ele. O cookie `personificando_tenant` diz QUAL conta.
 *
 * ========================= A PROPRIEDADE =========================
 *
 * **O cookie não concede nada. Ele estreita.**
 *
 * Toda policy de escrita deste banco é `auth_is_super_admin() OR (tenant_id =
 * auth_tenant_id())` — o JWT de um super já alcança todo cliente. O cookie só
 * diz ao painel qual tenant pôr nos filtros. Para quem não é super ele é
 * inerte, e isso depende de UMA coisa: a ORDEM em `obterUsuarioAtual`. O papel
 * sai do JWT primeiro; o cookie só é lido depois.
 *
 * Trocar essa ordem não dá erro nenhum — dá uma escada de privilégio silenciosa
 * em que qualquer `tenant_admin` lê a conta de qualquer outro cliente. Por isso
 * a ordem é afirmada aqui, no fonte, e não só "conferida ao ler".
 *
 * O QUE ESTE TESTE NÃO ALCANÇA, dito com letras: `obterUsuarioAtual` depende
 * de `cookies()` e da sessão do Supabase, que só existem dentro do Next. O
 * comportamento de ponta a ponta foi exercitado no navegador (super entrando,
 * `tenant_admin` com o cookie forjado não entrando), e o que mora aqui é a
 * guarda contra regressão.
 *
 *   npm run teste:personificacao
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let ok = 0;
const falhas = [];
const chk = (nome, cond, det = '') => {
  if (cond) { ok++; console.log(`  ok    ${nome}`); }
  else { falhas.push(nome); console.log(`  FALHA ${nome}${det ? ' - ' + det : ''}`); }
};
const ler = (p) => fs.readFileSync(path.join(RAIZ, p), 'utf8');
/** Linhas sem comentário: um `//` explicando a regra não é a regra. */
const semComentario = (s) => s.split(/\r?\n/)
  .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
  .join('\n');

console.log('\n=== 1. A ORDEM: papel do JWT antes do cookie ===\n');

const auth = semComentario(ler('src/lib/auth.ts'));
chk('o fonte foi lido (arquivo vazio aprovaria tudo)', auth.length > 1000, `${auth.length} chars`);

const iPapel = auth.indexOf("if (papel !== 'super_admin') return base;");
const iCookie = auth.indexOf('lerPersonificacao()');
chk('a saída para quem não é super_admin existe', iPapel > 0, String(iPapel));
chk('a leitura do cookie existe', iCookie > 0, String(iCookie));
chk('o PAPEL é conferido ANTES de o cookie ser lido', iPapel > 0 && iCookie > iPapel,
  `papel em ${iPapel}, cookie em ${iCookie}`);

// O papel vem do app_metadata do JWT e de nenhum outro lugar — é a regra 1 do
// CLAUDE.md, e aqui ela é o que separa estreitar de escalar.
chk('o papel sai do `app_metadata` do JWT', /const papel = meta\['papel'\]/.test(auth));
chk('...e `meta` é o `app_metadata`, não o `user_metadata`',
  /const meta = user\.app_metadata/.test(auth));

console.log('\n=== 2. O tenant personificado é CONFERIDO ===\n');

chk('o tenant alvo é lido do banco antes de valer',
  /from\('tenants'\)[\s\S]{0,200}\.eq\('id', alvo\)/.test(auth));
chk('tenant deletado ou inativo derruba a personificação',
  /cliente\.deletado_em !== null \|\| cliente\.ativo === false\) return base/.test(auth));

console.log('\n=== 3. O cookie só aceita UUID ===\n');

const perso = ler('src/lib/personificacao.ts');
chk('há validação de formato antes de o valor virar filtro',
  /\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}/.test(perso), 'sem regex de uuid');
chk('o cookie é httpOnly (JavaScript da página não o lê)', /httpOnly: true/.test(perso));
chk('...e é de sessão: não tem `maxAge` nem `expires`',
  !/maxAge|expires/.test(semComentario(perso)),
  'cookie persistente faria a agência amanhecer dentro da conta de um cliente');

console.log('\n=== 4. Sair sempre é possível ===\n');

const acoes = semComentario(ler('src/lib/personificacao-acoes.ts'));
chk('`sairDaConta` existe', /export async function sairDaConta/.test(acoes));
/*
 * Dentro da conta o papel EFETIVO é `tenant_admin`. Se a ação de sair usasse
 * `exigirSuperAdmin`, ela se recusaria a rodar justamente quando é necessária
 * — a agência entraria e não teria porta de volta.
 */
chk('as ações usam `obterUsuarioReal`, que atravessa a personificação',
  /obterUsuarioReal/.test(acoes));
chk('...e NÃO usam `exigirSuperAdmin`, que recusaria de dentro da conta',
  !/exigirSuperAdmin/.test(acoes));
chk('`entrarNaConta` recusa quem não é super_admin pelo papel REAL',
  /real\.papel !== 'super_admin'/.test(acoes));
chk('`obterUsuarioReal` devolve o papel verdadeiro',
  /papel: 'super_admin', tenantId: null, personificando: undefined/.test(semComentario(ler('src/lib/auth.ts'))));

console.log('\n=== 5. A faixa de aviso é obrigatória ===\n');

const layout = ler('src/app/(app)/layout.tsx');
chk('o layout monta a faixa quando há personificação',
  /usuario\.personificando \? <FaixaPersonificacao/.test(layout));
const faixa = ler('src/components/faixa-personificacao.tsx');
chk('a faixa diz o NOME do cliente, não o id', /\{nome\}/.test(faixa));
chk('...e avisa que a mudança é do cliente', /muda para o cliente/i.test(faixa));
chk('...e traz o botão de sair', /sairDaConta/.test(faixa));

console.log('\n=== 6. A tela da agência não edita mais o prompt ===\n');

/*
 * Era uma segunda cópia do editor do cliente. Cópia de tela envelhece sozinha:
 * o aviso de marcador, a contagem de caracteres e o assistente nasceram no
 * painel do cliente e nunca chegaram à cópia. E ela só cobria o que alguém
 * lembrou de duplicar — horário, catálogo e base nunca tiveram cópia.
 */
const ficha = ler('src/app/(app)/admin/tenants/[id]/page.tsx');
chk('o `PromptEditor` saiu da ficha do cliente', !/PromptEditor/.test(ficha));
chk('...e a consulta de `prompt_versoes` saiu junto (não sobrou ida ao banco órfã)',
  !/prompt_versoes/.test(semComentario(ficha)));
chk('no lugar dele está a porta de entrada na conta', /<EntrarNaConta/.test(ficha));
/*
 * A porta da LISTA mudou de arquivo em 11/11, junto com a reforma da tela: a
 * tabela virou componente de cliente (`lista-clientes.tsx`) para a busca
 * responder enquanto se digita. A asserção procura nos dois, porque o que
 * importa é a porta existir na lista — não em qual arquivo ela mora.
 */
const naLista = ler('src/app/(app)/admin/tenants/lista-clientes.tsx') + ler('src/app/(app)/admin/tenants/page.tsx');
chk('a lista de clientes também tem a porta', /<EntrarNaConta/.test(naLista));

console.log(`\n${falhas.length ? 'FALHOU' : 'passaram'}: ${ok} ok, ${falhas.length} falhas`);
if (falhas.length) { for (const f of falhas) console.log('  - ' + f); process.exit(1); }
