# Painel de Gestão de Agentes de IA — Especificação Técnica

## 1. Contexto e problema

Hoje cada cliente que contrata um agente de IA exige trabalho manual no Adminer:
criar registro do tenant, escrever o prompt, inserir documentos na base vetorial,
configurar tokens. Isso não escala e o cliente não tem autonomia — qualquer ajuste
de prompt vira uma mensagem de WhatsApp para o fornecedor.

O painel resolve dois problemas distintos, para dois públicos distintos:

**Para a agência (super admin):** provisionar um cliente novo em minutos, sem SQL.
Criar o tenant, gerar o prompt inicial, conectar ao Chatwoot. O único trabalho manual
que permanece é montar o workflow no n8n e apontá-lo para o tenant.

**Para o cliente (admin do tenant):** editar o próprio prompt, subir documentos para
a base de conhecimento, ver o histórico de conversas do seu agente. Sem acesso a
nada de outro cliente.

## 2. O que já existe (não construir do zero)

Um schema Postgres multi-tenant já foi desenhado e está em produção parcial:

- `tenants` — configuração por cliente (prompt, modelo, tokens, mensagens de sistema)
- `kb_documentos` — base vetorial com `pgvector`, embeddings de 1536 dimensões
- `conversas` — estado por conversa (ativo/pausado/resolvido)
- `tenant_tools` — quais tools cada cliente tem habilitadas
- `mensagens_log` — auditoria e billing
- RLS ativo em todas as tabelas com tenant, via `current_setting('app.tenant_id')`
- Função `match_kb_documentos(query_embedding, match_count, filter)` para busca vetorial

**Um cliente já está em produção:** Acqua Lavanderia, `chatwoot_account_id = 56`,
12 documentos vetorizados, 74 conversas registradas. O agente roda em n8n e consulta
esse banco. Qualquer mudança de schema precisa manter esse agente funcionando.

## 3. Decisões de arquitetura já tomadas

Estas foram discutidas e decididas. Não reabrir sem motivo forte.

### 3.1 Supabase como plataforma

Auth, banco e storage no Supabase. Motivo: o RLS passa a ler o JWT do usuário logado
em vez de depender de variável de sessão setada pela aplicação. O banco impede
vazamento entre tenants mesmo se o frontend tiver bug.

### 3.2 `tenants.id` é UUID, não `chatwoot_account_id`

O schema original usava `account_id` do Chatwoot como chave primária. Isso quebra o
fluxo de provisionamento: no painel você cadastra a empresa **antes** de criar a conta
no Chatwoot. Se o id depende do Chatwoot, não dá para criar o registro primeiro.

Portanto: `tenants.id UUID PRIMARY KEY DEFAULT gen_random_uuid()`, e
`chatwoot_account_id BIGINT UNIQUE` como coluna separada, nullable, preenchida no
momento da conexão.

### 3.3 Dois níveis de acesso

- `super_admin` — a agência. Vê e edita todos os tenants. Cria tenants novos.
- `tenant_admin` — o cliente. Vê e edita apenas o próprio tenant.

Não há nível "operador" por ora. O schema deve permitir adicionar depois sem migração
destrutiva (usar enum ou tabela de papéis, não boolean `is_admin`).

### 3.4 Ingestão de arquivos é assíncrona

Upload de PDF/DOCX é essencial. O caminho completo — upload → extração de texto →
chunking → embedding na OpenAI → gravação dos vetores — leva 30-60 segundos para um
PDF de 50 páginas. Isso não cabe num request HTTP.

Implementar com tabela `jobs_ingestao` (status: `pendente`, `processando`, `concluido`,
`erro`), processamento em Edge Function ou rota de background, e polling no frontend
mostrando progresso.

## 4. Stack

- **Next.js 15** (App Router, Server Components, Server Actions)
- **TypeScript** strict
- **Supabase** — Postgres + Auth + Storage + Edge Functions
- **@supabase/ssr** para integração com App Router
- **Tailwind CSS** + shadcn/ui
- **OpenAI** `text-embedding-3-small` (1536 dimensões — precisa bater com o schema existente)
- Deploy: Vercel

## 5. Modelo de dados

### 5.1 Tabelas novas (do painel)

```
usuarios_painel
  id             UUID PK, FK -> auth.users(id) ON DELETE CASCADE
  tenant_id      UUID FK -> tenants(id), NULL para super_admin
  papel          TEXT CHECK (papel IN ('super_admin','tenant_admin'))
  nome           TEXT
  criado_em      TIMESTAMPTZ

jobs_ingestao
  id             UUID PK
  tenant_id      UUID FK -> tenants(id)
  arquivo_nome   TEXT
  arquivo_path   TEXT              -- caminho no Supabase Storage
  status         TEXT CHECK (status IN ('pendente','processando','concluido','erro'))
  chunks_total   INT
  chunks_ok      INT
  erro_msg       TEXT
  criado_em      TIMESTAMPTZ
  concluido_em   TIMESTAMPTZ

prompt_versoes                     -- histórico, permite rollback
  id             UUID PK
  tenant_id      UUID FK -> tenants(id)
  conteudo       TEXT
  criado_por     UUID FK -> usuarios_painel(id)
  criado_em      TIMESTAMPTZ
```

### 5.2 Carga única de produção (substitui a migração in-place)

> **Revisado.** A versão anterior desta seção descrevia uma migração in-place
> (adicionar `id_novo`, popular, trocar constraints, renomear). Isso pressupunha
> que produção e painel viviam no mesmo banco. Não vivem: o schema com a Acqua
> Lavanderia está no **Postgres do Coolify** (`SEU_HOST_POSTGRES:5432`, banco
> `postgres`, schema `public`), e o painel está num **projeto Supabase novo**.
>
> Não existe BIGINT a converter. O schema do Supabase já nasceu com
> `tenants.id UUID PRIMARY KEY` e `chatwoot_account_id BIGINT UNIQUE` (migrações
> 01–08). O que resta é **copiar um tenant** de um banco para o outro.

Isso muda a natureza do risco. Não há `ALTER TABLE` em produção, nem janela onde
o schema fica meio convertido, nem DDL para reverter sob pressão. **O banco de
origem nunca é alterado** — o script de import abre a conexão como
`read only`. O rollback do cutover é reapontar a credencial do n8n.

**Origem** (Coolify, single-tenant — o banco inteiro é a Acqua):

| Tabela | Linhas | Destino |
|---|---|---|
| `documentos` (`id`, `text`, `embedding` vector(1536), `metadata`, `criado_em`) | 12 | `kb_documentos` |
| `contatos_chatwoot` (`id`, `conversation_id`, `account_id`, `phone`, `status`, `pausado_em`, `criado_em`, `atualizado_em`, `contact_name`) | 74 (**66** da conta 56) | `conversas` |

**`contatos_chatwoot` tem `account_id` próprio** — a origem não é single-tenant
como se supunha, e isso não era hipotético: das 74 linhas, **8 pertencem a
`account_id = 1`** e apenas 66 à Acqua. Importar a tabela inteira colocaria 8
conversas de outra conta do Chatwoot dentro do tenant da Acqua. O número "74
conversas" citado na seção 2 é a contagem da tabela, não do cliente.

A carga filtra por `account_id = 56` e o preflight imprime a distribuição,
mostrando o que ficou de fora em vez de descartar em silêncio.

**Datas da origem são `TIMESTAMP WITHOUT TIME ZONE`**, o destino é `TIMESTAMPTZ`.
Timestamp sem fuso inserido em `TIMESTAMPTZ` é interpretado no fuso da sessão: se
os fusos divergirem, toda conversa desloca horas sem erro nenhum, e só aparece
quando alguém estranha a "última atividade". Verificado: o servidor de origem
roda em `Etc/UTC`, então os valores já são UTC e a conversão explícita
(`at time zone 'UTC'`) é isomórfica. Se o Coolify migrar de servidor, reconferir.

**`status` é `varchar` livre na origem** e o destino tem `CHECK` de três valores.
Verificado: só existe `'ativo'` nas 66 linhas, então nenhum mapeamento extra é
necessário. O mapeamento continua explícito e o preflight **aborta** diante de
valor desconhecido em vez de assumir um padrão — se amanhã aparecer `'resolved'`
do Chatwoot, mapeá-lo para `'ativo'` faria conversa encerrada voltar como ativa e
o agente responderia em conversa fechada.

**Identidade das linhas.** O tenant já existe no destino com UUID próprio; o
script o resolve por `chatwoot_account_id = 56` e nunca cria tenant. Os ids das
linhas filhas são **UUID v5 derivados** de `(tenant_id, tabela_origem, pk_origem)`
sob um namespace fixo do projeto. Consequência: rodar o import duas vezes
produz os mesmos ids e faz `UPDATE` das mesmas linhas em vez de duplicar. É o
que torna ensaio, re-execução e carga de delta seguros — sem tabela de/para
para dessincronizar.

**O `metadata` recebe o `tenant_id`; ele não existe na origem.** Verificado: as 12
linhas trazem apenas `blobType`, `fonte`, `loc` e `source` — nenhum marcador de
tenant. O agente em produção depende do banco ser single-tenant, não de filtro por
metadata. Portanto o `tenant_id` está sendo **acrescentado**, e nenhum filtro
existente no n8n quebra por isso. Ele é escrito porque o node PGVector filtra por
metadata e pode voltar a ser usado em algum fluxo; a barreira de isolamento é a
coluna `tenant_id`, aplicada por `api_n8n_buscar_kb`.

`metadata->>'fonte'` (`atendimento_acqua_ariquemes`) vira a coluna `origem` —
`source` é `"blob"` nas 12 linhas e não identifica nada. `chunk_index` não existe
na origem e é derivado da posição do chunk dentro de cada `fonte`, ordenado por
`id`.

**Verificação.** Contagem igual não prova nada — um erro de serialização produz
12 linhas com números errados e a contagem passa. O teste que pega isso é
**paridade de recall**: pegar o embedding de um documento real, buscar nos dois
bancos, comparar o top-3. Além disso: `vector_dims = 1536` em toda linha e
`metadata->>'tenant_id'` igual ao UUID em toda linha.

**Embeddings são copiados como estão.** Não re-embedar: custa dinheiro, muda os
resultados e destrói a comparação de paridade.

Implementação: `scripts/import-producao.mjs`. Cutover: `docs/n8n-cutover.md`.

### 5.3 RLS com JWT

O `tenant_id` do usuário vai no `app_metadata` do JWT (não em `user_metadata` — este
é editável pelo próprio usuário e não serve para autorização).

```sql
CREATE OR REPLACE FUNCTION auth_tenant_id() RETURNS UUID AS $$
  SELECT NULLIF(
    current_setting('request.jwt.claims', true)::jsonb
      -> 'app_metadata' ->> 'tenant_id', ''
  )::UUID;
$$ LANGUAGE SQL STABLE;

CREATE OR REPLACE FUNCTION auth_is_super_admin() RETURNS BOOLEAN AS $$
  SELECT COALESCE(
    current_setting('request.jwt.claims', true)::jsonb
      -> 'app_metadata' ->> 'papel', ''
  ) = 'super_admin';
$$ LANGUAGE SQL STABLE;
```

Policy padrão em cada tabela com tenant:

```sql
CREATE POLICY p_tenant ON kb_documentos
  USING (auth_is_super_admin() OR tenant_id = auth_tenant_id())
  WITH CHECK (auth_is_super_admin() OR tenant_id = auth_tenant_id());
```

### 5.4 O n8n também precisa acessar — DECIDIDO: Opção C

O n8n não tem JWT de usuário — conecta direto no Postgres. **Decisão: nenhuma das
duas opções originais.** Ambas foram descartadas na Fase 1:

**Opção A (`service_role`) — descartada.** A `service_role` key não é "acesso sem
RLS", é acesso total, inclusive a `auth.users` e a todas as tabelas do painel. Um
filtro esquecido não vazaria um tenant: vazaria o banco inteiro, com escrita. E
elimina qualquer rede de proteção no banco, contradizendo o motivo declarado na
§3.1 para escolher Supabase.

**Opção B (`SET app.tenant_id`) — descartada por ser inviável, não só arriscada.**
O workflow usa o node PGVector do LangChain, que **abre conexão própria**: o
`set_config` de um node anterior nunca alcança a query. Além disso `SET` sem
`LOCAL` persiste na conexão do pool e a próxima query, de outro tenant, herda o
valor anterior — vazamento silencioso e intermitente. E a cláusula extra ficaria
permanentemente em toda policy do sistema, inclusive para o tráfego do painel.

**Opção C (implementada):** role dedicado + API de funções com o tenant na
assinatura.

- Role `n8n_agent`, `LOGIN NOBYPASSRLS`, **sem privilégio em tabela nenhuma**
- Um conjunto pequeno e versionado de funções `api_n8n_*`, `SECURITY DEFINER`,
  com `EXECUTE` revogado de `public`/`anon`/`authenticated` e concedido só a
  `n8n_agent`:

| Função | Uso |
|---|---|
| `api_n8n_tenant_por_chatwoot(bigint)` | webhook entrega `account_id` → config do agente |
| `api_n8n_credencial_chatwoot(uuid)` | token, separado para não cair no log de todo node |
| `api_n8n_buscar_kb(uuid, vector, int, jsonb)` | substitui o node PGVector |
| `api_n8n_conversa_sync(uuid, bigint, text, text)` | registra a conversa e devolve o estado |
| `api_n8n_definir_status_conversa(uuid, bigint, text)` | pausar/retomar |
| `api_n8n_registrar_mensagem(...)` | auditoria e billing |
| `api_n8n_tools_ativas(uuid)` | tools habilitadas |

O ponto central: **o filtro de tenant não pode ser esquecido, porque é a
assinatura da função.** Não depende do n8n lembrar de escrever um `WHERE`, e o
corpo é código versionado, não configuração de node.

Dois ganhos que vêm junto:

- Credencial do n8n comprometida faz apenas o que a API permite, por tenant. Não
  lê `auth.users`, não escreve em `usuarios_painel`.
- Vira o **contrato estável** entre o banco e o n8n — o problema que o CLAUDE.md
  levanta ("toda mudança em `kb_documentos`/`conversas`/`tenants` pode quebrar o
  agente"). Com a API no meio, renomear coluna deixa de ser risco de produção.

Custo aceito: o workflow precisa ser reescrito, e o node PGVector vira
HTTP (embedding) + Postgres (`api_n8n_buscar_kb`). Ver `docs/n8n-cutover.md`.

**Consequência colateral:** `auth_tenant_id()` aceitava `app.tenant_id` como
origem alternativa de tenant — resquício da Opção B. Como toda policy chama essa
função, era um caminho de autorização paralelo ao JWT. Sem consumidor, foi
removido na migração 10.

Conexão: **via Supavisor (pooler), não pelo host direto** — `db.<ref>.supabase.co`
é IPv6-only e o n8n no Coolify é IPv4. Como não há estado de sessão a preservar,
o transaction mode (6543) funciona.

## 6. Funcionalidades por papel

### 6.1 Super admin (a agência)

- **Listar tenants** — nome, status, nº de documentos, nº de conversas, última atividade
- **Criar tenant** — formulário: nome, slug, prompt inicial (com template por segmento),
  modelo, temperatura. Cria o registro e o usuário admin do cliente, dispara convite por email.
- **Conectar ao Chatwoot** — informar `chatwoot_account_id` e token. Validar com uma
  chamada de teste à API antes de salvar.
- **Editar qualquer tenant** — acesso completo a tudo que o tenant_admin vê
- **Suspender/reativar** — `tenants.ativo = false` faz o agente parar de responder
- **Métricas globais** — mensagens por tenant no mês, consumo de tokens

### 6.2 Tenant admin (o cliente)

- **Editar prompt** — textarea com preview, salva versão no histórico, botão de rollback
- **Base de conhecimento** — listar documentos, subir arquivo (PDF/DOCX/TXT), colar texto,
  excluir documento (soft delete), ver status de processamento
- **Conversas** — listar conversas do próprio tenant, ver histórico, pausar/retomar o agente
  numa conversa específica
- **Configurações** — mensagens de sistema (fallback de mídia, fora de escopo),
  tempo de debounce, ligar/desligar o agente
- **Não pode** — ver outros tenants, editar tokens do Chatwoot, alterar modelo/temperatura
  (decisão: isso fica com a agência para evitar custo descontrolado)

## 7. Pipeline de ingestão

```
1. Cliente faz upload no painel
   -> arquivo vai para Supabase Storage em bucket `documentos/{tenant_id}/{uuid}.pdf`
   -> cria registro em jobs_ingestao com status 'pendente'

2. Trigger (Edge Function ou rota /api/ingest chamada após upload)
   -> marca job como 'processando'
   -> baixa o arquivo do Storage
   -> extrai texto (pdf-parse para PDF, mammoth para DOCX)
   -> chunking: ~800 tokens com overlap de 100
   -> para cada chunk: chama OpenAI embeddings (batch de 20 por request)
   -> insere em kb_documentos com tenant_id e metadata {tenant_id, origem, chunk_index}
   -> atualiza chunks_ok a cada batch (permite mostrar progresso)
   -> marca job como 'concluido'

3. Frontend faz polling em jobs_ingestao a cada 2s enquanto houver job ativo
   -> mostra "processando 12/40 chunks"
```

**Detalhes que importam:**

- O `metadata` precisa conter `tenant_id` porque o node PGVector do n8n filtra por
  metadata, não por coluna. Redundante de propósito.
- Embedding em lote reduz custo e latência. Não fazer um request por chunk.
- Se o job falhar no meio, os chunks já inseridos permanecem. Ou implementar
  transação por job, ou permitir reprocessamento idempotente (deletar chunks
  daquele `origem` antes de reinserir).
- Limite de tamanho de arquivo: começar com 10MB. Acima disso, avisar o cliente.

## 8. Fases de implementação

Construir nesta ordem. Cada fase deve estar funcionando antes de começar a próxima.

### Fase 1 — Fundação
- Projeto Next.js + Supabase configurado
- Migração do schema: UUID, tabelas novas, RLS com JWT — migrações 01–08
- Acesso do n8n: **Opção C** decidida e implementada — migração 09
- Remoção do fallback `app.tenant_id` em `auth_tenant_id()` — migração 10
- Seed com 3 tenants de teste (ver seção 10)
- Carga única de produção (§5.2) — **feita e verificada**: 12 documentos e 66
  conversas da Acqua no Supabase, seed do tenant removido
- Cutover do n8n (`docs/n8n-cutover.md`) — pendente
- **Critério de conclusão:** testes de isolamento passam com 3 tenants, e o
  role `n8n_agent` não alcança tabela nenhuma diretamente

### Fase 2 — Auth e navegação
- Login/logout com Supabase Auth, recuperação de senha
- Middleware protegendo rotas e fazendo refresh de sessão
- Layout com sidebar diferenciada por papel
- Página de listagem de tenants (super admin) e dashboard do tenant
- Migração 12: trigger passa a sincronizar no `UPDATE` do `app_metadata` —
  sem isso o GoTrue não conseguia criar usuário nenhum
- `scripts/criar-super-admin.mjs` para o primeiro acesso
- **Critério de conclusão:** tenant_admin logado não consegue acessar rota de outro tenant
  nem por URL direta. Provado em `tests/isolamento-fase2.mjs`, com três usuários reais
  autenticando de verdade — rodar como `postgres` passa enganosamente (ver adendo §5).

### Fase 3 — Gestão de tenant ✅
- Listagem com ações + criação de tenant (super admin)
- Convite de admin do cliente: `createUser` com `app_metadata` + link de
  recuperação surfaceado no painel (sem SMTP)
- Conexão com Chatwoot validando o token com chamada real antes de salvar
- Edição de prompt com versionamento (trigger) e rollback
- Restrição de coluna por papel via trigger `tenants_guard_colunas` (migração 13)
- **Critério de conclusão atingido:** cliente novo provisionado inteiro pelo
  painel, sem SQL (criar → convidar → validar Chatwoot → suspender). A restrição
  de coluna é provada em `tests/restricao-coluna-fase3.mjs` (10/10).

### Fase 4 — Base de conhecimento
- Listagem de documentos
- Upload de arquivo + pipeline de ingestão assíncrona
- Adicionar texto colado (caminho síncrono, mais simples)
- Exclusão (soft delete)
- **Critério de conclusão:** subir um PDF de 30 páginas e o agente no n8n responder
  usando aquele conteúdo

### Fase 5 — Operação
- Listagem de conversas
- Pausar/retomar agente por conversa
- Métricas de uso
- **Critério de conclusão:** cliente consegue diagnosticar sozinho por que o agente
  não respondeu uma conversa

## 9. Segurança — regras não negociáveis

1. **`tenant_id` vem sempre do JWT, nunca do request.** Se uma rota aceita `tenant_id`
   como parâmetro do body ou query, é vulnerabilidade. A única exceção é super_admin,
   e mesmo assim a rota precisa verificar o papel no servidor.

2. **RLS ativo em toda tabela com `tenant_id`.** Sem exceção. Se uma tabela nova não
   tem policy, ela vaza.

3. **`service_role` key nunca vai para o cliente.** Só em Server Actions, Route Handlers
   e Edge Functions. Se aparecer em componente client, é incidente.

4. **Migrações rodam com role que bypassa RLS.** Rodar migração com RLS ativo faz
   `ALTER TABLE` afetar só a visão do tenant atual, silenciosamente.

5. **Storage com RLS por path.** Bucket `documentos` com policy que só permite acesso
   a `{tenant_id}/*` do próprio tenant.

6. **Rate limit por tenant, não global.** Um cliente subindo 200 PDFs não pode travar
   a ingestão dos outros.

## 10. Seed de desenvolvimento

Criar **três** tenants no seed, não um nem dois:

- Um tenant reflete o caso feliz e esconde todo bug de isolamento
- Dois tenants escondem bugs onde A vaza para B mas não B para A
- Três pegam erros de ordenação e filtro que só aparecem com múltiplos pares

Sugestão: `Acqua Lavanderia` (espelhando o cliente real, com 12 documentos),
`Clínica Teste` e `Restaurante Teste`, cada um com 3-5 documentos e algumas conversas.

## 11. Fora de escopo (por ora)

Não construir, mas deixar o caminho aberto:

- Billing e cobrança automática
- Criação do workflow n8n pelo painel (continua manual)
- Editor visual de fluxo do agente
- Multi-idioma
- White-label por cliente
- App mobile
