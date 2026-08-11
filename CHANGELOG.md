# Changelog

Gerado a partir do histórico Git em **2026-08-06**, janela pedida de 30 dias
(desde 2026-07-07). Classificação por leitura das mensagens de commit — que neste
repositório são detalhadas o bastante para sustentar a categorização — e por verificação
no código quando o efeito de uma mudança não estava explícito.

> **Sobre a janela:** os 30 dias contêm **todo** o histórico do projeto. O primeiro commit é
> de **2026-07-28**, então o intervalo real são **10 dias** (28/07 a 06/08), não 30. Nada
> foi omitido por corte de data.

**28 commits · 279 arquivos alterados · +20.021 / −1.924 linhas · 12 migrações**

| Data | Commits | Foco do dia |
|---|---|---|
| 2026-07-28 | 7 | núcleo, deploy, gestão de admins, correções de auditoria |
| 2026-07-30 | 5 | transferência para humano, limpar memória, exclusão de cliente |
| 2026-08-03 | 8 | design (tema, drawer, rebranding) e correções de varredura |
| 2026-08-04 | 5 | polimento de UI, a11y e duas correções de segurança |
| 2026-08-06 | 3 | catálogo de tools, organização de docs, alinhamento de migrações |

---

## ⚠️ Breaking changes

Mudanças que exigem ação ou que alteram comportamento de dado já existente.

### `dea97b6` — Node 20 → Node 22 obrigatório
`@supabase/supabase-js` emite deprecation em Node 20 e vai remover o suporte. A base da
imagem subiu para `node:22-alpine`. **Ambiente de deploy em Node 20 precisa subir.**

### `a940cfd` — chunk padrão da ingestão: 600 → 450 caracteres
Alinhamento de paridade de recall com os chunks que o n8n já havia gravado em produção
(média ~380 chars). **Documentos ingeridos antes desta mudança têm chunking diferente dos
posteriores**, e não existe caminho de reindexação para job já concluído — só re-subindo o
arquivo à mão. O teste de recall da Fase 4 mediu 3/5 com chunk grande contra 5/5 alinhado.

### `a940cfd` — `ingerirTexto` limitado a 50.000 caracteres
O caminho síncrono de texto colado passou a recusar acima de 50k (antes aceitava e
estourava timeout). **Texto maior agora precisa ser enviado como `.txt`** pelo caminho
assíncrono.

### `b33a537` + `402d8d3` — semântica de `formatarDestino` mudou
Antes o painel prependia `55` e mantinha o nono dígito, gerando JID que a linha do WhatsApp
não usava (WAHA recusava com 422). Agora **exige número internacional completo** (≥12
dígitos, com código do país) ou o JID colado, e não mexe mais no nono dígito. Efeito
prático: **um destino salvo sob a lógica antiga produz JID diferente do que produziria
hoje**, e reeditar aquele campo exige o formato novo.

### `f8cc6fa` (migração 18) — `tenant_tools`: INSERT e DELETE viram super_admin-only
Fecha furo de escrita: `tenant_admin` deixa de poder inserir linha nova ou deletar. Passa a
editar apenas `ativo` e `config` da própria linha, via whitelist de trigger. **Qualquer
fluxo que dependesse de tenant_admin criar a própria linha para de funcionar** — por
desenho.

### `c8c2407` — 6 migrações renomeadas para bater com o ledger
As migrações 09, 10, 12, 13, 14 e 15 tinham no nome de arquivo um timestamp diferente do
registrado em `supabase_migrations.schema_migrations` (efeito de terem sido aplicadas por
SQL avulso). Sem o alinhamento, `supabase db push` enxergaria seis migrações já aplicadas
como novas e as replayaria **contra produção**. **Clones antigos precisam refazer o
checkout de `supabase/migrations/`.**

### Verificado e **não** é breaking: `f8cc6fa` (migração 19) — coluna `contratado`

`api_n8n_tools_ativas` passou a filtrar `contratado AND ativo`, o que parece quebrar o
contrato do agente em produção. **Não quebra:** a coluna nasce `not null default true` e a
migração ainda faz o backfill explícito, então para os dados existentes
`contratado AND ativo == ativo` e o retorno da função é idêntico byte a byte. A assinatura
também não mudou. O que muda é dali para frente — **tool nova exige contratação explícita
pela agência** antes de chegar ao agente.

---

## ✨ Features

### Plataforma
- **`e38c2a7`** — **Núcleo do painel (Fases 1-5).** Next.js 15 + Supabase multi-tenant:
  código-fonte, migrações com rollback, Edge Function de ingestão, scripts e testes de
  isolamento. Deploy via Dockerfile (Next standalone) + tutorial Coolify.
- **`f8cc6fa`** — **Catálogo de tools multi-tenant.** Permite à agência vender módulos por
  cliente sem editar o workflow compartilhado do n8n: tabela `catalogo_tools`, registry no
  código como fonte de UI, e três telas (Admin › Catálogo CRUD, Admin › cliente › Módulos,
  cliente › Meus módulos). Acompanha 17 asserts de segurança e script no `package.json`.

### Gestão de clientes (super_admin)
- **`befb147`** — **Excluir cliente (soft delete).** Grava `deletado_em` + `ativo=false`,
  com confirmação exigindo digitar o nome do cliente conferido contra o banco. Nunca
  `DELETE` físico — o n8n lê o mesmo banco.
- **`40f94c5`** — **Gestão de admins do cliente.** Remover (Auth + projeção
  `usuarios_painel`), editar nome e reenviar link de acesso. Todas confirmam contra o banco
  que o alvo é `tenant_admin` **deste** tenant.

### Painel do cliente
- **`1e98a35`** — **Configuração de transferência para humano.** A tool `transferir_humano`
  ganha UI, com corte explícito cliente × agência: o cliente liga/desliga, define horário e
  destino; a agência define workflow, descrição e sessão WAHA. Cada lado faz merge do
  `config` jsonb preservando os campos do outro.
- **`c1e6077`** — **Limpar memória do agente.** Botão para limpar a memória conversacional
  (que vive no Redis, do lado do n8n) de uma, várias ou todas as conversas, via webhook com
  segredo compartilhado. Não apaga o histórico exibido.
- **`8b783f9`** — **Ver conteúdo do documento.** Expande o documento e mostra os chunks
  indexados — o texto que o agente de fato consulta —, carregados sob demanda e escopados
  por tenant.
- **`719141e`** — **Orientação para montar prompt e base.** Novo `lib/orientacao.ts` com
  modelo de prompt em 7 blocos e dicas, exposto em blocos recolhíveis no editor e na base
  de conhecimento.
- **`a45bdbb`** — **Dispensar job de ingestão com erro**, com delete escopado por tenant +
  status e guarda de rowcount.
- **`4088f89`** — **Aba Uso reformulada:** número grande + tendência contra o mês anterior,
  no lugar da barra relativa sem escala (que parecia cota).

### Design e interface
- **`45d9e13`** — **Rebranding ChatYou:** primária laranja `#F59600`, Montserrat, logo por
  tema, botões em pílula, cards `rounded-2xl`.
- **`2b82f84`** — **Tema claro/escuro** com persistência em `localStorage` e script inline
  anti-flash antes do paint.
- **`ab5da38`** — **Sidebar responsiva:** vira drawer abaixo de `md`, com overlay e
  fechamento automático ao trocar de rota. Variante `warning` no `Alert`.
- **`a45bdbb`** — Tokens `--success`/`--warning` e escala de arredondamento coerente.
- **`20ebe2e`** — **Suporte a token de Agent Bot no Chatwoot.** Token de bot dá 401 em
  `GET /accounts/{id}` mesmo sendo válido; novo checkbox aceita o 401 e salva como
  não-validado, mantendo validação estrita para token de usuário.

---

## 🐛 Fixes

### `a940cfd` — Correções da auditoria (o maior lote)
**Altos:**
- *Salvar Configurações (tenant_admin) falhava sempre* — `validarEdicaoTenantAdmin` exigia
  `system_prompt`, campo que o formulário não tem.
- *Editar config do cliente (super_admin) falhava sempre* — `editarTenantSuper` reusava
  `validarCriacaoTenant`, e o slug dummy `"_"` normalizava para `""` (inválido). Nasce daí
  o `validarConfigTenantSuper`.

**Médios:** sessão caindo intermitentemente (o middleware descartava os `Set-Cookie` de
refresh no redirect); `conectarChatwoot` com token em branco agora reaproveita o salvo;
`adicionarPreco` valida modelo contra whitelist e virou `<select>` (typo não gera mais custo
0 silencioso).

**Robustez:** filtro explícito de tenant em `reprocessar`/`listarStatusJobs`/`subirArquivo`
(regra 6); `definirStatusConversa` não reporta sucesso com 0 linhas afetadas; comparação do
segredo em tempo constante na Edge Function.

### `f70be7e` — Convite e recuperação quebrados no deploy
Dois bugs: (1) o link usava `properties.action_link` (fluxo *implicit*, token no fragmento
`#`, que o servidor não lê) enquanto `/auth/confirmar` espera `?token_hash=&type=`; (2) os
redirects usavam o `origin` do request, e atrás do proxy da Coolify o container se vê como
`0.0.0.0:3000`, mandando o navegador para host inalcançável. Passa a usar
`NEXT_PUBLIC_SITE_URL`.

### `402d8d3` — Achados da varredura
`excluirDocumento` confere linhas afetadas antes de reportar "removido";
`salvarTransferirHumanoAgencia` sem sessão WAHA grava canal `'nenhum'` em vez de deixar
`'waha'` pendurado; `ingerirTexto` exige `corpo.ok === true` (200 não garante conclusão no
síncrono); `invocarProcessamento` com segredo ausente retorna `ok:false` em vez de lançar,
para não deixar arquivo e job órfãos no Storage.

### Outros
- **`85b3d3c`** — `excluirTenant` zera `chatwoot_account_id`/`chatwoot_token`: o
  `account_id` é UNIQUE e, preso ao tenant excluído, impedia religar aquela conta a outro
  cliente.
- **`443aa01`** — Item ativo da sidebar: `/painel` acendia junto de toda sub-rota, porque
  toda elas começam com `/painel/`. Passa a marcar o href mais específico.
- **`30ef633`** — `workflow_id` removido do card de transferência: travava a criação e era
  metadado morto (no agente atual as tools são fixas nos nós).
- **`4088f89`** — Lote de correções de design review, várias de acessibilidade: foco sem
  halo branco no dark, `aria-expanded`/`aria-controls` + `Esc` + `inert` no drawer,
  `role="progressbar"` com aria, exclusão de documento em 2 passos, erros de página usando
  `Alert` em vez de `<div>` cru.

---

## 🔒 Segurança

- **`ffbd0dc`** — **Open redirect por backslash.** `/\evil.com` virava host externo no
  pós-login (phishing), porque o browser normaliza `\` para `/`. A regex passa a barrar `/`
  **e** `\` como segundo caractere. No mesmo commit, `segredoConfere` da Edge Function vira
  fail-closed: `INGESTAO_SECRET` vazio ou curto retorna `false` (dois vazios dariam match).
- **`e4e0c54`** — `match_count` clampado em 1..50 em `match_kb_documentos`, em paridade com
  `api_n8n_buscar_kb`. Não é cross-tenant; evita `match_count` arbitrário (DoS/custo).
- **`f8cc6fa`** (migração 18) — Fecha o furo de escrita em `tenant_tools` (ver Breaking).
- **`85b3d3c`** — `obterUsuarioAtual` passa a negar login de `tenant_admin` cujo tenant
  esteja excluído ou pausado. Sem isso o soft delete mantinha a linha e o JWT válido, e o
  admin seguia acessando os dados do cliente excluído. Fail-closed.
- **`078040d`** — **PII removida do versionamento.** O export do n8n entrou por engano via
  `git add -A` e continha telefone e avatar de um contato real no `pinData`. Destrackeado e
  adicionado ao `.gitignore`. ⚠️ **Segue no histórico do Git** — remover de verdade exigiria
  reescrever a história.

---

## 📚 Documentação e infraestrutura

- **`0680e50`** — 14 `.md` soltos na raiz agrupados em `docs/` por assunto
  (`especificacao/`, `auditorias/`, `n8n/`, `marca/`), mais o guia `ADICIONAR-TOOL.md` e o
  índice `docs/README.md`.
- **`c8c2407`** — Migração 11 (`api_n8n_config_tool`), migração 18 (índice de histórico de
  conversa), `supabase/baseline/` (reconstrução das migrações 01-08, que nunca foram
  versionadas) e templates de email.

---

## 🔎 Pendências registradas nos próprios commits

Itens que os commits deixaram explicitamente em aberto — vale não perdê-los de vista:

1. **Duas migrações rotuladas "18"** (`18_indice_historico_conversa` e
   `18_seguranca_tenant_tools`), com timestamps distintos. O `c8c2407` não renumerou para
   não dessincronizar do ledger, e recomenda revisar **antes do próximo `db push`**.
2. **Sem caminho de reindexação** para documento já concluído: mudar `CHUNK_ALVO_CHARS`
   hoje exige re-subir cada arquivo à mão.
3. **PII no histórico do Git** (`078040d`) — o arquivo saiu do working tree, não do
   histórico.

---

## Método

`git log` com corpo completo, `--shortstat` para volume e `--name-only` filtrado por
`supabase/migrations/` para atribuir cada migração ao seu commit. A classificação seguiu as
mensagens, que neste repositório descrevem causa e efeito; onde o rótulo do commit não
bastava para decidir se algo era breaking, fui ao código — foi o caso da migração 19, que
**parece** quebrar o contrato do n8n e não quebra, por causa do default e do backfill
explícito. Nenhum commit foi omitido: os 28 do repositório estão cobertos.
