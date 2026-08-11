# Auditoria de Dependências — ChatYou · IA

> Data: **2026-08-06**. Node local v24.13.0 / npm 11.6.2. Runtime alvo: **Node 22**
> (`node:22-alpine` no Dockerfile).
> Tudo aqui foi apurado com `npm ls`, `npm outdated`, `npm audit` e `npm view` rodados
> de verdade; as afirmações sobre compatibilidade foram **testadas**, não presumidas.
> Complementa (e em um ponto **corrige**) a §3 de [`AUDIT-DEBITO.md`](AUDIT-DEBITO.md).

## Resumo

Árvore pequena e saudável: **101 pacotes** no lockfile (28 prod, 60 dev, 60 opcionais —
os opcionais são quase todos binários de plataforma do `sharp`/`oxide`/`lightningcss`).
Zero pacotes deprecados, zero conflito de versão, zero dependência não usada.

Três achados que valem ação:

1. **As 3 vulns HIGH do `npm audit` são corrigíveis sem migrar para Next 16.** Dois
   `overrides` resolvem — verificado em lockfile isolado, `found 0 vulnerabilities`.
   O `AUDIT-DEBITO.md` afirma que só dá para corrigir com `audit fix --force` → Next 16;
   está desatualizado.
2. **As dependências da Edge Function estão fora de qualquer inventário** e são as mais
   atrasadas do projeto (`unpdf` 0.12.1 quando o latest é 1.8.0), com um agravante de
   supply-chain: são URLs `esm.sh` sem lockfile nem integridade.
3. **`@supabase/ssr` e `@supabase/supabase-js` estão acoplados na subida.** Ir para
   `ssr@0.12.4` exige `supabase-js >= 2.111.0` — não dá para atualizar um sem o outro.

---

## 1. Inventário — dependências diretas

Versão instalada = o que está no `package-lock.json` (lockfileVersion 3).

### Produção

| Pacote | Range | Instalada | Wanted | Latest | Situação |
|---|---|---|---|---|---|
| `next` | `^15.5.4` | 15.5.21 | **15.5.22** | 16.3.0 | patch trivial; major adiado |
| `react` | `^19.1.0` | 19.2.8 | 19.2.8 | 19.2.8 | ✅ em dia |
| `react-dom` | `^19.1.0` | 19.2.8 | 19.2.8 | 19.2.8 | ✅ em dia |
| `@supabase/supabase-js` | `^2.58.0` | 2.110.8 | **2.112.2** | 2.112.2 | minor pendente |
| `@supabase/ssr` | `^0.7.0` | 0.7.0 | 0.7.0 | **0.12.4** | 5 minors 0.x atrás |
| `lucide-react` | `^0.469.0` | 0.469.0 | 0.469.0 | **1.29.0** | major |
| `tailwind-merge` | `^2.6.0` | 2.6.1 | 2.6.1 | **3.6.0** | major (ver §4) |
| `class-variance-authority` | `^0.7.1` | 0.7.1 | 0.7.1 | 0.7.1 | ✅ em dia |
| `clsx` | `^2.1.1` | 2.1.1 | 2.1.1 | 2.1.1 | ✅ em dia |
| `server-only` | `^0.0.1` | 0.0.1 | 0.0.1 | 0.0.1 | ✅ (stub da Vercel) |

### Desenvolvimento

| Pacote | Range | Instalada | Wanted | Latest | Situação |
|---|---|---|---|---|---|
| `typescript` | `^5.7.0` | 5.9.3 | 5.9.3 | **7.0.2** | major |
| `tailwindcss` | `^4.1.13` | 4.3.3 | 4.3.3 | 4.3.3 | ✅ em dia |
| `@tailwindcss/postcss` | `^4.1.13` | 4.3.3 | 4.3.3 | 4.3.3 | ✅ em dia |
| `@types/node` | `^22.10.0` | 22.20.1 | 22.20.1 | 26.1.2 | **manter em 22** — casa com `node:22-alpine` |
| `@types/react` | `^19.1.0` | 19.2.17 | 19.2.18 | 19.2.18 | patch |
| `@types/react-dom` | `^19.1.0` | 19.2.3 | 19.2.4 | 19.2.4 | patch |
| `pg` | `^8.22.0` | 8.22.0 | 8.22.0 | 8.22.0 | ✅ em dia — usado só por `scripts/` |

`pg` em `devDependencies` está **correto**: só entra em `scripts/import-producao.mjs` e
`scripts/teste-recall.mjs` (ferramental de operação), nunca no bundle do app.

### Edge Function (Deno) — `supabase/functions/processar-ingestao/index.ts`

Não passam pelo `package.json`, então nenhum `npm audit`/`outdated` as enxerga.

| Import | Fixada | Latest | Distância |
|---|---|---|---|
| `https://esm.sh/@supabase/supabase-js@2.58.0` | 2.58.0 | 2.112.2 | 54 minors |
| `https://esm.sh/unpdf@0.12.1` | 0.12.1 | **1.8.0** | major |
| `https://esm.sh/mammoth@1.8.0` | 1.8.0 | 1.12.0 | 4 minors |
| `jsr:@supabase/functions-js/edge-runtime.d.ts` | sem pin | — | só tipos |

Sem SDK da OpenAI — a chamada de embeddings é `fetch` direto para
`api.openai.com/v1/embeddings` (`index.ts:171`). Uma dependência a menos, decisão boa.

---

## 2. Vulnerabilidades

`npm audit`: **3 HIGH, 0 critical/moderate/low**. Todas transitivas, todas via `next`.

| Pacote | Instalada | Advisory | CVSS | Caminho |
|---|---|---|---|---|
| `postcss` | 8.4.31 | [GHSA-6g55-p6wh-862q](https://github.com/advisories/GHSA-6g55-p6wh-862q) — leitura arbitrária de arquivo via `sourceMappingURL` | 7.5 | `next` → `postcss` (pin exato `8.4.31`) |
| `postcss` | 8.4.31 | [GHSA-r28c-9q8g-f849](https://github.com/advisories/GHSA-r28c-9q8g-f849) — path traversal no auto-load de source map | 7.5 | idem |
| `postcss` | 8.4.31 | [GHSA-qx2v-qp2m-jg93](https://github.com/advisories/GHSA-qx2v-qp2m-jg93) — XSS por `</style>` não escapado | 6.1 | idem |
| `postcss` | 8.4.31 | [GHSA-fxqj-rqcc-2cmp](https://github.com/advisories/GHSA-fxqj-rqcc-2cmp) — correção incompleta da GHSA-6g55 | — | idem |
| `sharp` | 0.34.5 | [GHSA-f88m-g3jw-g9cj](https://github.com/advisories/GHSA-f88m-g3jw-g9cj) — CVE-2026-33327/33328/35590/35591 herdadas do libvips | high | `next` → `sharp` (optional) |

**Exposição real é baixa, e por motivos verificáveis:**

- O `postcss` vulnerável é o que o **Next** fixa (`postcss: "8.4.31"`, versão exata) para
  o próprio pipeline de CSS. O `postcss` que o Tailwind usa é o da raiz, **8.5.23, não
  vulnerável**. As duas coexistem na árvore. Ambas rodam só em **build-time**, sobre CSS
  do próprio repositório — não há CSS de terceiro entrando no pipeline.
- O `sharp` só é exercitado pelo otimizador de imagem do Next. O app **não usa
  `next/image`** — a única ocorrência de "next/image" no `src/` é o matcher `_next/image`
  do `middleware.ts:15`; os logos são servidos com `<img>`. Fora do caminho de runtime.

### Correção sem major — verificada

`npm audit fix --force` propõe **Next 16.3.0** (breaking). Não é necessário. O Next 16
resolve essas vulns simplesmente subindo as mesmas duas dependências:

```
next@15.5.22 → postcss 8.4.31   sharp ^0.34.3
next@16.3.0  → postcss 8.5.23   sharp ^0.35.3
```

Ou seja, dá para adotar exatamente as versões do Next 16 permanecendo no Next 15, via
`overrides` no `package.json`:

```jsonc
"overrides": {
  "postcss": "^8.5.23",
  "sharp": "^0.35.3"
}
```

**Testado** em cópia isolada do `package.json` + lockfile
(`npm install --package-lock-only` + `npm audit`): resolveu `postcss@8.5.26` e
`sharp@0.35.3` → **`found 0 vulnerabilities`**. Nada foi alterado no projeto.

Risco do override: baixo, porque não estamos inventando um par de versões — é o par que
o Next 16 já ships. Ainda assim, `sharp` é `optionalDependency` com binários nativos:
depois de aplicar, confirmar `npm run build` e, no Docker, que o `.next/standalone` sobe.

---

## 3. Compatibilidade entre pacotes

Nenhum `UNMET`/`invalid` em `npm ls`. Peer deps conferidas uma a uma:

| Restrição | Exigido | Temos | Status |
|---|---|---|---|
| `next@15.5.21` → `react` | `^18.2.0 \|\| ^19.0.0` | 19.2.8 | ✅ |
| `next@15.5.21` → `react-dom` | `^18.2.0 \|\| ^19.0.0` | 19.2.8 | ✅ |
| `next@15.5.21` → engines node | `^18.18 \|\| ^19.8 \|\| >=20` | 22 (Docker) / 24 (local) | ✅ |
| `@supabase/ssr@0.7.0` → `supabase-js` | `^2.43.4` | 2.110.8 | ✅ |
| `@tailwindcss/postcss@4.3.3` → `postcss` | `^8.5.16` | 8.5.23 (raiz) | ✅ |
| `pg@8.22.0` → `pg-native` | `>=3.0.1` (opcional) | ausente | ✅ (usa driver JS) |
| `lucide-react@0.469` → `react` | `^16 \|\| ^17 \|\| ^18 \|\| ^19` | 19.2.8 | ✅ |

**Acoplamento a observar:** `@supabase/ssr@0.12.4` exige `@supabase/supabase-js ^2.111.0`.
Como temos 2.110.8, **subir o `ssr` obriga a subir o `supabase-js` junto** — é uma
atualização só, não duas independentes. Fazer o `supabase-js` primeiro (2.112.2), validar,
depois o `ssr`.

**Skew Edge Function ↔ app:** a Edge Function roda `supabase-js@2.58.0` e o painel
`2.110.8`. Não é erro (processos separados, sem código compartilhado), mas as duas falam
com a mesma API PostgREST/Storage; divergência grande de client é uma fonte silenciosa de
comportamento diferente entre o upload (painel) e a ingestão (function).

---

## 4. Verificações de compatibilidade que **não** deram problema

Vale registrar, porque descartam trabalho que parecia necessário:

**`tailwind-merge@2` com Tailwind v4 — funciona.** A leitura natural da tabela de
desatualizadas é que `tailwind-merge` 2.x é da era do Tailwind v3 e estaria desalinhado
com o `tailwindcss@4.3.3` do projeto — o sintoma seria `twMerge` deixando de deduplicar
utilitários renomeados na v4, e o `cn()` dos 12 componentes `ui/*` passando a depender da
ordem do CSS em vez da ordem dos argumentos. **Testado com o pacote instalado:**

```
shadow-sm shadow-xs   → shadow-xs     rounded-sm rounded-xs → rounded-xs
blur-sm blur-xs       → blur-xs       bg-linear-to-r bg-linear-to-l → bg-linear-to-l
```

Resolve certo a escala nova e o `bg-linear-*` da v4. E o `src/` **não usa nenhuma** classe
exclusiva da v4 (`grep` por `shadow/rounded/blur-xs`, `bg-linear-to-*`, `outline-hidden`:
zero ocorrências). O major 2 → 3 é higiene, **não** correção de bug.

**`@types/node` 22 vs latest 26 — ficar em 22 é o certo**, não dívida. O tipo tem que
casar com o runtime, e o runtime é `node:22-alpine`. Subir para 26 introduziria tipos de
API que a produção não tem.

**Sem dependência não usada e sem duplicata conflitante.** `clsx`/`cva`/`tailwind-merge`
entram por `lib/utils.ts:cn` e pelos componentes `ui/*`; `server-only` está em uso; `pg`
nos scripts. A única duplicata de versão na árvore é o `postcss` 8.4.31 (Next) vs 8.5.23
(raiz) — que é justamente o achado da §2.

**Ruído menor:** `npm ls` reporta `@emnapi/runtime@1.11.2` como `extraneous`. É resíduo
dos binários opcionais do `sharp` no `node_modules` local; não está no caminho do build e
some em `npm ci`.

---

## 5. Supply chain

- **npm:** lockfile v3 com `integrity` em todas as entradas, `npm ci` reprodutível. Sem
  dependência apontando para git/tarball/URL. Sem pacote deprecado.
- **Edge Function:** aqui está a fraqueza. Três imports por URL de **`esm.sh`**, um CDN de
  terceiro, resolvidos **em deploy sem lockfile e sem hash de integridade**. Versão está
  fixada (bom), mas nada garante que o byte servido hoje seja o de ontem, e o código roda
  com **`SERVICE_ROLE_KEY`** no ambiente. Mitigação padrão do Deno: criar um
  `supabase/functions/deno.json` com `imports` + `deno.lock` versionado, ou trocar `esm.sh`
  por `npm:` (suportado pelo runtime das Edge Functions), que resolve pelo registry.
- `caniuse-lite@1.0.30001806` está recente — sem aviso de browserslist desatualizado.

---

## 6. Ordem sugerida

| # | Ação | Risco | Ganho | Custo |
|---|---|---|---|---|
| 1 | `overrides` de `postcss`/`sharp` (§2) + `npm run build` | Baixo | **audit zerado** sem major | ~15 min |
| 2 | `next` → 15.5.22, `@types/react`/`react-dom` → patch | Baixo | correções acumuladas | ~10 min |
| 3 | `@supabase/supabase-js` → 2.112.2 | Baixo–médio | base para o `ssr`; alinha com a Edge Function | ~20 min + smoke de auth/storage |
| 4 | `deno.json` + `deno.lock` na Edge Function (§5) | Baixo | fecha o buraco de integridade | ~30 min |
| 5 | Edge Function: `mammoth` 1.12, `unpdf` 1.8 (major) | **Médio** | correções de parsing | exige re-subir PDF/DOCX de teste e conferir os chunks |
| 6 | `@supabase/ssr` 0.7 → 0.12.4 (depois do #3) | **Médio** | 5 minors de correção de cookie/SSR | changelog + teste de sessão |
| 7 | `tailwind-merge` 3, `lucide-react` 1, `typescript` 7 | Médio | higiene | adiar — nenhum resolve bug atual |
| — | `next` 16 | Alto | — | **não é necessário** para as vulns; só quando houver motivo próprio |

⚠️ **#5 toca a ingestão.** Trocar o extrator de PDF muda o texto extraído, o texto muda o
chunking e o chunking muda o recall — que o n8n consome do mesmo banco. Vale a regra do
`CLAUDE.md`: re-rodar `npm run teste:recall` antes e depois e comparar os números.

---

## Método

`npm ls --depth=0`, `npm outdated --json`, `npm audit --json`, `npm view` (registry
público), leitura direta do `package-lock.json` e dos imports em
`supabase/functions/processar-ingestao/index.ts`. O teste de `overrides` rodou em cópia
do `package.json`/lockfile fora do repositório. O teste do `twMerge` rodou contra o
`node_modules` real. **Nenhum arquivo do projeto foi alterado nesta auditoria.**
