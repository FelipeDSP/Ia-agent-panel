# Auditoria de Cobertura de Testes

> Data: **2026-08-06**. Leitura dos 3 arquivos de teste (980 linhas, 52 asserções),
> cruzada com os 131 exports levantados em [`../API-PUBLICA.md`](../API-PUBLICA.md).
> Estimativa por inspeção — **não há instrumentação de cobertura instalada** e nenhum
> framework de teste no `package.json`. Nada foi alterado.

## Resumo

A cobertura deste projeto não é fraca — é **deslocada de camada**. Os testes existentes
são bons: usuários reais, JWT de verdade, três tenants, e a recusa explícita de rodar
como `postgres` (que passaria enganosamente ignorando RLS). O que eles testam é o
**banco**: policies, triggers, guards de coluna, isolamento entre tenants.

O que não testam é o **código**.

| Camada | Cobertura | Evidência |
|---|---|---|
| RLS / policies / triggers | **forte** | 52 asserções, 3 tenants × 3 vias de ataque |
| Rotas HTTP (middleware, redirect de sessão) | **parcial e condicional** | 3 rotas; pula se `npm run dev` não estiver de pé |
| Código da aplicação (131 exports) | **~0%** | nenhuma asserção sobre função TypeScript |
| Edge Function `processar-ingestao` | **0%** | nenhum teste a alcança |

Dos 131 exports, **7 são exercitados** — e apenas como *infraestrutura* dos testes
(`carregarEnv`, `criarUsuario`, `acharPorEmail`, `ehEmailDuplicado`, `removerPorEmail`,
`removerPorId`, `listarUsuarios`, todos de `scripts/lib/`). Se um quebrar, os testes
falham; mas nenhuma asserção é *sobre* eles. **Zero das 31 Server Actions, zero das 6
funções `validar*`, zero dos 23 componentes.**

**A conclusão prática não é "escreva testes para tudo".** É que o RLS funciona como rede
de segurança para a maior parte do código não testado — um bug na checagem de tenant de
uma Server Action ainda esbarra na policy. O risco real está concentrado nas funções
**puras** que decidem coisas que o banco não tem opinião nenhuma sobre. São poucas, são
triviais de testar, e é ali que está a §4.

---

## 1. O que É coberto

### `tests/isolamento-fase2.mjs` — 23 asserções, 3 tenants, 3 vias

Prova que `tenant_admin` não alcança dado alheio por: (1) chamada de API autenticada,
(2) parâmetro forjado com o `tenant_id` do outro, (3) URL direta com cookie de sessão real.

Tabelas e RPCs cobertas: `tenants`, `kb_documentos`, `conversas`, `usuarios_painel`,
`tenant_tools`, `match_kb_documentos`, `api_n8n_buscar_kb`. Inclui tentativa de `INSERT`
com `tenant_id` alheio e a busca vetorial com uuid forjado.

Rotas HTTP: `/login`, `/painel`, `/admin/tenants` — com e sem sessão. ⚠️ **Esta camada só
roda com o servidor de pé** e reporta "pulado" caso contrário. Honesto, mas significa que
num CI sem `npm run dev` a cobertura de rota é **zero** e o teste ainda sai verde.

### `tests/restricao-coluna-fase3.mjs` — 11 asserções

Guard de coluna por papel: `tenant_admin` edita `system_prompt`/mensagens/`debounce`/
`agente_ativo`; é **barrado** em `modelo`, `temperatura`, `chatwoot_token`, `ativo`;
`super_admin` passa. Confirma que `prompt_versoes` acumulou e preservou o prompt anterior.

⚠️ Não tem script npm — só roda digitando o caminho. Ver `AUDIT-IMPORTS.md` §5.

### `tests/seguranca-tenant-tools.mjs` — 18 asserções

Policies por comando em `tenant_tools` pós-migração 18: `tenant_admin` não enumera
catálogo, não insere, não deleta, não troca `workflow_id`/`descricao`/`contratado`; edita
`ativo`+`config` (whitelist); `super_admin` faz tudo. Verifica o estado no banco depois de
cada tentativa bloqueada, não só o código de erro — é o detalhe que separa um teste que
prova de um que acredita.

## 2. O que NÃO é coberto

| Grupo | Exports | Testados |
|---|---|---|
| Server Actions (`'use server'`) | 31 | **0** |
| Funções de `src/lib/` | 28 | **0** |
| Componentes (`components/` + páginas) | 68 | **0** |
| Edge Function (`chunk`, `embeddarLote`, `segredoConfere`, `extrairTexto`) | — | **0** |
| `scripts/lib/` | 11 | 7 exercitados como infra, 0 asseridos |

## 3. Por que isso importa menos do que parece

O `CLAUDE.md` manda rodar duas camadas — filtro explícito de tenant **e** RLS. Essa
decisão é o que segura a falta de testes de unidade: se `salvarPrompt` esquecer o `if` de
tenant, a policy ainda barra. O código não testado está, na maior parte, **atrás de uma
rede testada**.

A pergunta útil de priorização passa a ser: **onde o banco não tem opinião?**

| Função | Pura? | O banco cobre? | Risco se quebrar |
|---|---|---|---|
| `destinoSeguro` (`(auth)/acoes.ts:24`) | ✔ | **não** | open redirect / phishing pós-login |
| `segredoConfere` (Edge Fn `:323`) | ✔ | **não** | portão da ingestão aberto |
| `chunk` (Edge Fn `:112`) | ✔ | **não** | recall do agente + custo (ver `AUDIT-COMPLEXIDADE.md` §3) |
| `MODELOS_PERMITIDOS` via `validar*` | ✔ | **não** — ver abaixo | modelo inválido gravado, agente quebra em produção |
| `formatarDestino` / `numeroParaExibir` | ✔ | **não** | transferência humana vai para o número errado |
| `normalizarSlug` | ✔ | parcial (UNIQUE) | colisão de slug |
| `validar*` (temperatura, debounce) | ✔ | **sim** (CHECK 0..2 / 1..60) | baixo — mensagem feia, não dado ruim |
| checagem de tenant nas Actions | ✘ | **sim** (RLS + guard) | baixo |

### O caso do `modelo` — o único gate sem rede

`schema.ts` documenta em que CHECKs do banco ele se apoia: `temperatura 0..2`,
`debounce 1..60`, `slug`/`chatwoot` UNIQUE. **`modelo` não está na lista, e não está no
banco:**

```sql
-- baseline/00_schema_base.sql:142
modelo  text not null default 'gpt-4.1-mini',   -- sem CHECK
```

A whitelist `MODELOS_PERMITIDOS` existe só em JS. Ou seja: **`validarConfigTenantSuper` é
o único ponto de aplicação de uma regra cuja violação quebra o agente em produção** — o
n8n lê `tenants.modelo` para escolher o LLM. É a função com maior razão risco/cobertura do
projeto, e tem zero testes.

## 4. As duas lacunas que eu trataria primeiro

**(a) O commit de segurança `ffbd0dc` não trouxe teste nenhum.** Ele corrigiu dois bugs
reais — open redirect via `/\evil.com` (o browser normaliza `\` para `/`) e
`INGESTAO_SECRET` vazio dando match — e tocou **3 arquivos de código, 0 de teste**. As
duas correções vivem em funções puras, sem I/O, testáveis em três linhas cada. Do jeito
que está, exatamente o bug que foi consertado pode voltar sem ninguém notar.

**(b) A regex do open redirect está duplicada, e nenhuma das cópias é testada.**

```ts
// src/app/(auth)/acoes.ts:25
if (proximo && proximo.startsWith('/') && !/^\/[/\\]/.test(proximo))
// src/app/auth/confirmar/route.ts:32
proximo && proximo.startsWith('/') && !/^\/[/\\]/.test(proximo) ? proximo : '/'
```

Mesma regra de segurança, escrita duas vezes, inline, nenhuma exportada. Quem corrigir uma
pode não achar a outra. Extrair para `lib/` e testar a função extraída resolve as duas
lacunas de uma vez.

## 5. Sugestão

O maior ganho não é um framework — é **exportar as funções puras críticas e cobrir cada
uma com meia dúzia de casos**. Elas não precisam de banco, de rede, nem de servidor: rodam
em `node --test`, que já vem no Node 22, sem adicionar dependência (ver
`AUDIT-DEPENDENCIAS.md` antes de instalar qualquer coisa).

| # | Alvo | Casos mínimos | Custo |
|---|---|---|---|
| 1 | Extrair a regex de redirect para `lib/` + testar | `/painel` ok · `//evil.com` barra · `/\evil.com` barra · `null` → padrão por papel | ~30 min |
| 2 | `segredoConfere` | segredo vazio → false · curto (<24) → false · tamanho diferente → false · correto → true | ~15 min |
| 3 | `validar*` (as 6) | modelo fora da whitelist · temperatura limite · slug inválido · campo faltando | ~1 h |
| 4 | `chunk` | texto < alvo → 1 chunk · overlap respeitado · **passo mínimo com overlap alto** (`AUDIT-COMPLEXIDADE.md` §3) | ~45 min |
| 5 | `formatarDestino` / `numeroParaExibir` | com/sem DDI · com máscara · inválido → null | ~20 min |
| 6 | `CHECK` de `modelo` no banco, ou aceitar o JS como gate único e documentar | migração + rollback | ~30 min |
| 7 | `"teste:restricao"` no `package.json` | — | 1 linha |
| 8 | Fazer a camada 3 do isolamento **falhar** (não pular) quando marcada como obrigatória | — | ~20 min |

Os itens 1, 2 e 4 cobrem exatamente as funções da tabela da §3 onde o banco não tem
opinião. São ~1h30 de trabalho para a parte do sistema onde hoje não existe rede nenhuma.

---

## Método

Contagem de `checar()` por arquivo, leitura integral dos 3 testes para mapear tabelas/RPCs/
rotas exercitadas, cruzamento com o inventário de exports, e verificação no
`supabase/baseline/00_schema_base.sql` de quais validações têm respaldo em `CHECK`/`UNIQUE`.
`git show` no commit de segurança para conferir se veio acompanhado de teste. **Estimativa
por inspeção — nenhum percentual aqui vem de instrumentação.**
