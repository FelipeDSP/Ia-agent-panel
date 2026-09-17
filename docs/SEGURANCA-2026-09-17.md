# Análise de segurança da plataforma — 17/09/2026

> Escopo: banco (Supabase), painel (`ia.chatyou.chat`), serviço do agente
> (`hercules.chatyou.chat`), integrações (Chatwoot, WAHA, Asaas, OpenAI) e o
> que ficou visível da infra (Portainer/Chatwoot). Tudo que está marcado como
> **medido** foi executado hoje contra produção (leitura, ou escrita dentro de
> transação revertida); o resto é leitura de código/config. Nada foi alterado.

## Resumo

A base está bem melhor do que a média: RLS em todas as tabelas, isolamento
entre tenants **medido** (tenant A lê 0 linhas de B em produtos, credenciais e
log; `anon` lê 0 linhas em todas as tabelas de negócio; `anon` não insere),
funções `SECURITY DEFINER` com ACL fechado (nenhuma aberta a `anon`/PUBLIC),
Storage com policy por pasta do tenant nos dois buckets, `service_role` só no
servidor (`server-only`), segredos fora do repositório, trace do agente sem
segredos (0 passos com aparência de chave).

O que precisa de ação, por ordem:

| # | Achado | Gravidade | Esforço |
|---|---|---|---|
| 1 | Next.js 15.5.21 com **2 CVEs críticas** (RCE) e sharp/postcss/nanoid altas | **Alta** | pequeno |
| 2 | `usuarios_painel`: o próprio usuário pode reescrever `papel`/`tenant_id` da sua linha (**medido**) | **Alta** (latente) | pequeno |
| 3 | Token do webhook do Chatwoot é **um só para todos os tenants** e fica visível no Agent Bot de cada conta | **Média-alta** | médio |
| 4 | Chatwoot: `SECRET_KEY_BASE` com cara de não-aleatório; `ENABLE_RACK_ATTACK=false`; imagem `develop` de um fork | **Média-alta** | pequeno (é config) |
| 5 | Token de usuário admin do Chatwoot (todas as contas) no env do agente | Média | pequeno |
| 6 | Painel sem cabeçalhos de segurança (HSTS, X-Frame-Options, CSP) | Média | pequeno |
| 7 | Sem MFA em nenhum usuário; 1 super_admin | Média | médio |
| 8 | Credenciais em `tenant_credenciais` em texto puro (Vault instalado e não usado) | Baixa-média | médio |
| 9 | `podcast_vagas` (view sem `security_invoker`, `anon` lê 9 linhas) — pendência já conhecida | Baixa | pequeno |
| 10 | Sobras: `backfill_*` com grants totais a `anon`; Portainer 2.27 (2.45 disponível) | Baixa | pequeno |

## Achados

### 1. Dependências do painel (Alta)

`npm audit --omit=dev` no painel: **1 crítica, 3 altas**. `next@15.5.21` está
na faixa de duas RCEs (`<15.5.24`): uma só em Windows (não nos afeta — Coolify
é Linux) e uma na **Image Optimization API com AVIF** — o painel não usa
`next/image` hoje (0 imports), o que reduz a exposição, mas a rota
`/_next/image` existe assim mesmo. `sharp` (libvips/libheif), `postcss`
(leitura de arquivo via sourceMappingURL) e `nanoid` completam a lista. O
serviço do agente: **0 vulnerabilidades**.

**Correção:** `npm i next@^15.5.24` (+ `npm audit fix`), `npm run build`,
`npm run teste`, deploy. Meia hora.

### 2. `usuarios_painel` — o usuário reescreve a própria linha (Alta, latente)

**Medido:** com o JWT de um `tenant_admin`, `update usuarios_painel set
papel='super_admin', tenant_id=null where id=<eu>` → **1 linha** (revertido).
Também `tenant_id` de outro tenant → 1 linha. A policy
`p_usuarios_update` permite `id = auth.uid()` sem restringir colunas; o
`chk_papel_tenant` só exige coerência entre `papel` e `tenant_id`, não impede
a troca.

**Por que não é incidente hoje:** a autorização vem do JWT
(`app_metadata`), que só o `service_role` grava; a tabela é projeção. Mas
ela é lida pelo admin (listas, reenvio de acesso) e, principalmente, o
desenho de **usuários por conta** planeja pôr `permissoes` nela — no dia em
que alguma checagem ler a tabela, isso vira escalada real.

**Correção:** trigger de guarda como o `tenants_guard_colunas`: quem não é
`super_admin` só altera `nome` (e talvez `email`) na própria linha. Migração
pequena + teste com sabotagem.

### 3. Webhook do Chatwoot com token único (Média-alta)

O serviço recebe `POST /chatwoot/<WEBHOOK_TOKEN>/<inbox>` e resolve o tenant
pelo par `account.id`/`inbox.id` **do corpo**. O token é um só para todos os
tenants e fica na URL do Agent Bot em **cada** conta do Chatwoot — visível a
qualquer administrador daquela conta, que hoje é o próprio cliente. Um
cliente (ou ex-cliente, ou quem tiver acesso ao Chatwoot dele) pode forjar
webhooks para o par de outro tenant (inteiros pequenos) e **injetar
mensagens** na conversa de outro cliente: o agente responde nela pelo bot
daquele tenant, gastando tokens e falando com o cliente final.

Não dá leitura de dados (o serviço só escreve na conversa indicada), mas é
cruzamento entre tenants por um segredo compartilhado.

**Correção:** token por tenant (`tenant_credenciais.webhook_token`), na URL do
bot de cada conta; o serviço resolve o tenant pelo token e **confere** que o
par do corpo pertence a ele. Rotação por cliente passa a existir. O painel já
tem a tela "Quem atende" que mostra a URL do bot — é lá que o token por
tenant aparece.

### 4. Chatwoot (Média-alta) — visto no Portainer, stack `chatwoot`

- `SECRET_KEY_BASE=123458bb…54321`: 32 hex com prefixo `12345` — parece
  editado à mão, não gerado. É a chave que assina cookies/sessões do Chatwoot;
  fraca ou previsível permite forjar sessão. **Gerar uma de 128 hex
  (`openssl rand -hex 64`) e trocar** (derruba as sessões abertas, só isso).
- `ENABLE_RACK_ATTACK=false`: sem limite de tentativas de login/API — força
  bruta livre em `app.chatyou.chat` (`FORCE_SSL=false` é ok porque o Traefik
  termina TLS). Ligar.
- Imagem `astraonline/astrachat:develop`: fork, tag móvel — cada "update the
  stack" traz o que o mantenedor subiu naquele dia (foi assim que a espera de
  25 s no áudio entrou em 11/09). Fixar uma tag/digest.
- `CHATWOOT_HUB_URL=https://www.nicksweb.com.br`: o fork reporta a um hub de
  terceiro. Saber o que vai nesse ping.
- Segredos (AWS, SMTP, Facebook, Postgres) em texto no compose: normal em
  compose, mas qualquer admin do Portainer os vê; o Portainer está em 2.27.4
  com 2.45.1 disponível (LTS antiga: atualizar).

### 5. `CHATWOOT_AGENCIA_TOKEN` (Média)

É o token do usuário **chatyou**, administrador em ~20 contas — humano, com
tudo o que um admin faz. Se o container do agente vazar, é acesso total ao
Chatwoot. **Correção:** usuário dedicado (`bot-avisos`), papel **agente** só
nas contas em `codigo` (criar contato e conversa não exige admin), token só
dele; rotação anual.

### 6. Cabeçalhos de segurança do painel (Média)

`ia.chatyou.chat` responde sem `Strict-Transport-Security`, `X-Frame-Options`
/ `frame-ancestors`, `X-Content-Type-Options` nem CSP (o Chatwoot tem ao menos
`X-Frame-Options: SAMEORIGIN`). Clickjacking do painel é o risco concreto.
**Correção:** `headers()` no `next.config.ts` — 15 linhas.

### 7. Autenticação dos humanos (Média)

6 usuários, **0 fatores MFA**, 1 super_admin (que administra todos os
clientes). Supabase Auth suporta TOTP; o painel não tem tela de inscrição.
**Correção:** MFA obrigatório para `super_admin` (tela de enrollment +
`aal2` exigido em `/admin`), opcional para clientes. Conferir no dashboard
do Supabase: política de senha, proteção contra senha vazada, rate limits
de OTP.

### 8. Credenciais em texto puro no banco (Baixa-média)

`tenant_credenciais` guarda `chatwoot_token`, `asaas_api_key_*`,
`asaas_webhook_token_*` em texto, protegidos por RLS `super_admin` (medido: o
tenant lê 0). A extensão `supabase_vault` está instalada e não é usada. Um
dump do banco ou um `postgres` comprometido expõe as chaves do Asaas de
todos os clientes — em produção isso é dinheiro. **Correção:** mover para o
Vault (ou criptografar com `pgcrypto` + chave no env do agente) quando a
conta PJ/BaaS do Asaas entrar em produção; hoje é sandbox.

### 9 e 10. Sobras

- `podcast_vagas`: view sem `security_invoker`, `anon` lê 9 linhas
  (agregado; não vaza PII) — `docs/PENDENCIA-PODCAST-VAGAS.md`.
- `backfill_22_tools_inseridas`, `backfill_57_nome_original`: tabelas de
  migração com grants totais a `anon`/`authenticated` (RLS segura: 0 linhas
  medidas) — dropar.
- `/saude` do agente é público e devolve o commit em execução: útil para
  monitorar, inofensivo; se incomodar, limitar por IP no Coolify.

## O que foi medido e está certo

- `anon` (chave publicável, sem sessão): 0 linhas em `tenants`,
  `tenant_credenciais`, `usuarios_painel`, `conversas`, `mensagens_log`,
  `produtos`, `pedidos`, `kb_documentos`, `catalogo_tools`, `precos_modelo`,
  `tenant_tools`, `prompt_versoes`; insert em `produtos` negado (42501);
  `agendar_podcast` negado; `match_kb_documentos` recusa sem tenant no JWT.
- `tenant_admin` de A: 0 linhas de B em `produtos`; 0 em
  `tenant_credenciais` e `mensagens_log` (super-only); `update` em produto
  de B afeta 0 linhas; não altera `agente_runtime` nem `nome` do próprio
  tenant (guard 42501).
- Nenhuma função `SECURITY DEFINER` executável por `anon`/PUBLIC; as
  `api_n8n_*`/`api_agente_*` só `service_role` + `n8n_agent`
  (`teste:grants-n8n`); as do painel só `authenticated`.
- `postgres` não é superusuário (tem BYPASSRLS); `service_role` só no
  servidor (`import 'server-only'`, build falha se um client importar);
  `agente_codigo` sem BYPASSRLS, e o `config.ts` recusa URL do `postgres`.
- Storage: dois buckets privados, limite de tamanho e MIME por bucket,
  policies por pasta `<tenant_id>/…` em SELECT/INSERT/UPDATE/DELETE.
- Webhook do Asaas: token por tenant validado no banco, 200 sempre,
  idempotente por evento; `receiveInCash`/confirmação só pelo webhook.
- Serviço: corpo limitado a 1 MB, JSON inválido não derruba, `limpar-memoria`
  por segredo em header, timeouts em toda chamada externa, filtro de
  injection no texto e na transcrição, portão de saída contra afirmação de
  pagamento/pedido, trace sem segredos (0 passos com chave).
- Retenção: texto apagado em 45 d, conversa anonimizada em 180 d (67).
- Git: nenhum `.env` versionado; varredura por padrões de chave não achou
  nada fora de testes/exemplos.

## Andamento

- **17/09 — feito, aguardando deploy do painel:** #1 (`next` 15.5.21 → 15.5.25,
  `sharp` 0.35.4, `nanoid`; sobra só `postcss` 8.4.31 preso dentro do `next`,
  cuja falha é de build com CSS de atacante — não há CSS de usuário aqui;
  aceito até o Next soltar); #6 (cabeçalhos em `next.config.ts`, sem CSP de
  script por enquanto); #2 (migração **73**, guarda de colunas em
  `usuarios_painel`, `teste:migracao-guard-usuarios` 12/12 com sabotagem —
  **APLICADA 17/09**, ledger `20260917230000`; a escalada medida agora dá
  42501 em produção). Suíte 88/88 depois da atualização.

## Plano sugerido (ordem)

1. **Hoje**: atualizar Next/sharp/postcss/nanoid (#1); cabeçalhos no
   `next.config.ts` (#6). Um deploy do painel.
2. **Esta semana**: guarda de colunas em `usuarios_painel` (#2, migração
   pequena); no Chatwoot, `SECRET_KEY_BASE` novo, `ENABLE_RACK_ATTACK=true`,
   fixar a tag da imagem (#4); usuário dedicado para o token da agência (#5).
3. **Antes de migrar Empório/CEEJAAR**: token de webhook por tenant (#3) —
   é quando passa a haver mais de um cliente real no serviço.
4. **Antes do Asaas em produção**: credenciais no Vault (#8); MFA no
   super_admin (#7).

Itens 1, 2 e 6 eu faço com teste e deixo prontos para deploy; 3 é uma
entrega própria (migração + painel + serviço); 4 e 5 são no Portainer e no
Chatwoot, com você.
