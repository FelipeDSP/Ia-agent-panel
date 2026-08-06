# Levantamento de Dívida Técnica — ChatYou · IA

> Mapeamento apenas — **nada refatorado**. Cada item de código morto/duplicação foi
> confirmado por busca no repositório. `npm audit`/`npm outdated` rodados de verdade.
> Data: 2026-08-04.

## Resumo
Código **enxuto e limpo** para o tamanho: **zero TODO/FIXME/HACK**, **zero `any`**, nenhuma
supressão de erro do compilador, `ignoreBuildErrors: false`. A dívida real é: alguns
**vulns transitivos** (só corrigíveis com Next 16), **duplicação de utilitários** (data,
`ErroCampo`), **tipos de DB escritos à mão** (sem geração a partir do schema), **3 estilos
de tabela**, e um **arquivo-deus** (`admin/acoes.ts`).

## 1. Código morto (confirmado por busca)
- **`podcast_agendamentos` (tabela) + `agendar_podcast` (função) + índices** — `grep`
  por "podcast" no `src/` retorna **zero** ocorrências. É de **outra aplicação** que
  compartilha o banco; morto do ponto de vista do painel. (Também é achado de segurança/
  dados nas outras auditorias.)
- **PII no `agente ia workflow.txt`** (fora do repo, gitignored) e no histórico do Git —
  artefato morto/legado.
- **Nada mais confirmado como morto no `src/`**: buscas por utilitários/exports suspeitos
  (`formatarDataHora`, `MODELOS_PRECIFICAVEIS`, `numeroParaExibir`, exports de
  `orientacao.ts`, componentes `ui/*`) mostraram todos referenciados. Os scripts
  (`import-producao`, `teste-recall`, testes `.mjs`) são referenciados por `package.json`.
- ⚠️ **Método:** não há ferramenta de dead-code (knip/ts-prune) instalada. A varredura foi
  por busca dirigida; para garantia total, rodar `npx knip` seria o próximo passo.

## 2. Duplicação (3+ ou padrão repetido)
| Item | Ocorrências | Onde |
|---|---|---|
| **Formatação de data** `new Date(x).toLocaleString('pt-BR', {dateStyle,timeStyle})` inline | **4** — e já existe `lib/utils.ts:formatarDataHora` (usada em outros 2 lugares!) | `conhecimento/componentes.tsx:46`, `conversas/lista.tsx:29`, `conversas/[id]/page.tsx:13`, `admin/tenants/[id]/page.tsx:237` |
| **`function ErroCampo({msg})`** idêntico | **4** | `tenants/novo/formulario.tsx:14`, `configuracoes/formulario.tsx:12`, `configuracoes/formulario-transferir.tsx:14`, `admin/tenants/[id]/componentes.tsx:26` |
| **`function StatusBadge`** | 2 (domínios diferentes: job vs conversa) | `conhecimento/componentes.tsx:52`, `conversas/lista.tsx:20` |
| **Cast de resultado PostgREST** `(x ?? []) as Type[]` | ~7 | admin/consumo, painel/consumo, admin/tenants, conhecimento/acoes, etc. (sintoma do item 4) |
| **Conversão NUMERIC→`Number()`** (custo/tokens) | vários | páginas de consumo/billing |
| **Harness de teste** (`checar`, `autenticar`) | 2 | os dois testes `.mjs` |

## 3. Dependências
**`npm audit`: 3 vulnerabilidades HIGH** (transitivas do Next):
- **postcss** (`<=8.5.22`) — XSS/path-traversal via `sourceMappingURL` em CSS. Build-time.
- **sharp** (`<0.35.0`) — CVEs do libvips. O app usa `<img>`, **não** `next/image`, então
  o `sharp` quase não está no caminho de runtime.
- Correção só via `npm audit fix --force` → **Next 16 (breaking)**. Risco real **baixo**
  para este app (build processa o próprio CSS; sem processamento de imagem não confiável),
  mas rastrear.

**Desatualizadas:**
| Pacote | Atual | Patch fácil | Latest (major) |
|---|---|---|---|
| next | 15.5.21 | **15.5.22** (trivial) | 16.3.0 |
| @supabase/supabase-js | 2.110.8 | **2.112.0** | — |
| @supabase/ssr | 0.7.0 | — | 0.12.4 (vários minors — revisar changelog) |
| lucide-react | 0.469.0 | — | 1.28.0 (major) |
| tailwind-merge | 2.6.1 | — | 3.6.0 (major) |
| typescript | 5.9.3 | — | 7.0.2 (major) |
| @types/node | 22.20.1 | — | 26 (manter em 22 — runtime é Node 22) |

- **Sem dependências não usadas** detectadas (`clsx`/`cva`/`tailwind-merge` via `cn`/`cva`;
  `server-only` usado; `pg` usado pelos scripts). Sem versões conflitantes duplicadas.

## 4. Tipagem
- ✅ **Limpo:** zero `any`, zero `@ts-ignore`/`@ts-expect-error`, `strict` + `ignoreBuildErrors:false`.
- ⚠️ **Dívida principal — tipos de DB escritos à mão.** Não há geração de tipos do Supabase;
  os resultados de query/RPC são afirmados manualmente: `(consumoRaw ?? []) as LinhaConsumo[]`
  (`admin/consumo/page.tsx:53`), `as JobStatus[]` (`conhecimento/acoes.ts:301`), `as
  Partial<ConfigTransferir>` (várias), `as Modelo` (`schema.ts:104,166`), `as
  Record<string, unknown>` (`auth.ts:41`, `conhecimento/page.tsx:25`). Se o schema mudar,
  esses tipos **mentem silenciosamente**. Correção: `supabase gen types typescript` + usar
  os tipos gerados no cliente.

## 5. TODOs / FIXMEs
**Nenhum.** Busca por `TODO|FIXME|XXX|HACK|gambiarra|temporári|workaround|arrumar depois`
no `src/` não retornou marcadores de dívida. Os `eslint-disable-next-line` existentes são
**intencionais e localizados** (`@next/next/no-img-element` nos logos da marca).

## 6. Inconsistência de padrão
- **3 estilos de tabela** (já apontado no design): `<Table>` shadcn em `admin/tenants`,
  `<table>` cru em `admin/consumo`, flexbox em `conversas/lista`.
- **`ErroCampo`/`StatusBadge`/formatador de data** — mesma coisa de formas diferentes (item 2).
- **Tratamento de erro divergente** — alguns retornam `error.message` cru, outros mensagem
  genérica (visto em AUDIT-CONFIABILIDADE).
- **Nomes:** consistentes (domínio PT-BR, código inglês — segue CLAUDE.md). Sem divergência.
- **Estrutura:** coerente com a arquitetura declarada; exceção é o god-file do item 7.

## 7. Complexidade (maiores arquivos)
| Arquivo | Linhas | Nota |
|---|---|---|
| `admin/acoes.ts` | **581** | **Arquivo-deus:** ~8 server actions (criar/convidar/remover admin, gerar link, conectar Chatwoot, editar/excluir tenant, transferência da agência). Candidato a split por subdomínio (`admin/tenants.acoes.ts`, `admin/usuarios.acoes.ts`, `admin/chatwoot.acoes.ts`). |
| `admin/tenants/[id]/componentes.tsx` | 488 | Vários formulários num arquivo. |
| `conhecimento/componentes.tsx` | 469 | `GestaoConhecimento` + `BotaoExcluir` + `DocumentoItem` + `StatusBadge` + muito estado. |
| `processar-ingestao/index.ts` | 366 | Pipeline inteiro (chunk/embed/swap/http) — aceitável p/ Edge Function. |
| `conhecimento/acoes.ts` | 302 | 6 actions. |
- Sem aninhamento profundo alarmante; a maioria das funções é linear. O problema é
  **concentração de responsabilidade** (admin/acoes.ts), não profundidade ciclomática.

## 8. Configuração hardcoded
- **`'https://app.chatyou.chat'`** default de `chatwoot_url` (`admin/acoes.ts:320`) —
  hardcoded; deveria ser env/const de marca.
- **Timeouts** `10_000` (Chatwoot), `15_000` (n8n) — hardcoded; poderiam ser const nomeadas.
- **`LIMITE_BYTES = 10MB`** (`conhecimento/acoes.ts`) — hardcoded (enquanto os tamanhos de
  chunk **são** env-configuráveis — bom; o limite de upload ficou de fora).
- **Edge:** `DIMENSAO=1536`, `LOTE_EMBEDDING=20`, `MODELO_EMBEDDING` — constantes (ok);
  chunk-alvo/overlap são env (bom).
- **`agendar_podcast`**: `v_limite=6` e período `2026-08-01..09` hardcoded na função SQL.
- **Senha mínima 8** (`(auth)/acoes.ts`) — hardcoded; ok, mas seria const.
- `'http://localhost:3000'` fallbacks — aceitáveis como fallback de dev.

---

## Ranking de limpezas de maior retorno (baixo risco × alto ganho de clareza)

| # | Limpeza | Risco | Ganho | Esforço |
|---|---|---|---|---|
| 1 | **Unificar formatação de data** — remover os 4 inlines e usar `formatarDataHora` (já existe) | Baixo | Alto (menos código, um só formato) | ~30 min (conferir paridade do formato) |
| 2 | **Extrair `ErroCampo`** para `components/ui/` (4 → 1) | Baixo | Alto | ~20 min |
| 3 | **Patches de dependência** — `next` 15.5.22 + `supabase-js` 2.112 (sem major) | Baixo | Médio (correções, base atualizada) | ~15 min + build |
| 4 | **Gerar tipos do Supabase** e trocar os `as Type[]` pelos tipos gerados | Baixo–médio | **Alto** (segurança de tipo real contra drift de schema) | ~1–2 h |
| 5 | **Consolidar as 3 tabelas** no `<Table>` do shadcn (casa com o item 4 do design review) | Médio | Alto (consistência visual + código) | ~1–2 h |
| 6 | **`StatusBadge` genérico** em `components/ui/` (parametrizar variantes) | Baixo | Médio | ~20 min |
| 7 | **Extrair timeouts / URL default para constantes nomeadas** (`lib/config`) | Baixo | Médio (clareza, um lugar) | ~30 min |
| 8 | **Quebrar `admin/acoes.ts`** por subdomínio | Médio | Alto (navegabilidade) | ~1–2 h |
| 9 | **Rodar `npx knip`** para varredura exaustiva de código morto | Baixo | Médio (fecha a lacuna do item 1) | ~30 min |
| 10 | **Decidir sobre `podcast_agendamentos`** (mover p/ outro banco) | — (decisão) | Alto (blast-radius) | — |

### Nota de método
`npm audit`/`npm outdated` executados. Código morto e duplicação confirmados por `grep`
dirigido (não presumido). Para dead-code exaustivo faltaria `knip`/`ts-prune` (item 9).
Nada foi alterado.
