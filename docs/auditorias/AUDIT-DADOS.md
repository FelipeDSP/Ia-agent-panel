# Auditoria de Proteção de Dados (LGPD/GDPR) — ChatYou · IA

> Investigação apenas — **nada corrigido**. Baseado no schema do banco (verificado em
> produção), no código e nos subprocessadores identificados no código. Data: 2026-08-04.

## Contexto de papéis (essencial para LGPD)
Há **duas camadas de titulares**:
- **Usuários do painel** (admins dos clientes + super_admin da agência) — ChatYou é
  **controlador** dos dados deles (email, nome).
- **Clientes finais** (as pessoas que conversam com o agente via WhatsApp/Chatwoot —
  nome e telefone em `conversas`, conteúdo em `mensagens_log`) — aqui a **empresa cliente
  é a controladora** e a **ChatYou/agência é operadora (processadora)**. O painel processa
  dado pessoal de terceiros em nome do cliente.

Essa distinção define quem responde a um pedido de titular e sob qual base legal.

---

## 1. Inventário de dado pessoal

| Local | Campo | Tipo de dado | Sensível? | Observação |
|---|---|---|---|---|
| `conversas` | `contact_name` | Nome do cliente final | Não* | *pode revelar identidade |
| `conversas` | `phone` | Telefone/WhatsApp do cliente final | Não* | plaintext |
| `mensagens_log` | `conteudo` | Conteúdo de mensagens do cliente final | **Potencialmente sim** | pode conter qualquer coisa que a pessoa digitou (saúde, doc, etc.) |
| `mensagens_log` | `conversation_id`, `direcao`, `criado_em`, tokens | Metadado de conversa | Não | |
| `kb_documentos` | `text`, `metadata`, `embedding` | Conteúdo da base do cliente | **Depende** | se o cliente subiu documento com PII, ela vive aqui (e vira embedding) |
| `usuarios_painel` | `email`, `nome` | Identificação do admin | Não | |
| `tenants` | `nome` | Nome da empresa (ou pessoa, se MEI) | Não* | |
| `tenants` | `chatwoot_token` | Credencial (não pessoal) | — | plaintext (achado S1) |
| `tenant_tools` | `config.notificacao.destino` | WhatsApp da agência/atendente p/ aviso | Não* | plaintext |
| `jobs_ingestao` | `arquivo_nome`, `criado_por` | Nome de arquivo / autor | Não | |
| `prompt_versoes` | `criado_por` | Autor da versão | Não | |
| `podcast_agendamentos` | `nome`, `empresa`, `whatsapp` | Identificação de inscrito | Não* | **outra aplicação** no mesmo banco |
| `auth.users` (GoTrue) | `email`, `encrypted_password`, tokens de recovery | Auth do admin | — | senha com hash (bcrypt) |
| **Storage** `kb-arquivos/<tenant>/*` | Arquivos originais (PDF/DOCX/TXT) | Conteúdo do cliente | **Depende** | persistem mesmo após "excluir" o documento |
| **Supabase Auth Logs** | email do admin, IP, timestamp | Metadado de acesso/auth | Não* | retenção da plataforma |
| **Hosting logs** (Vercel/Coolify) | IP, URL, timestamp | Metadado de request | Não* | |
| **n8n + Redis** | conteúdo de mensagem, telefone, buffers de memória por conversa | Conteúdo do cliente final | **Potencialmente sim** | fora do banco principal |
| **Chatwoot** | conversas, contatos (nome+telefone), mensagens | Origem de todo o dado do cliente final | **Potencialmente sim** | sistema externo |
| **Git (repo público)** | telefone real no histórico (commit `20ebe2e`) | PII | Não* | exposição contínua |

\* "Não sensível" no sentido do art. 11 da LGPD (não é dado de saúde/raça/etc.), mas ainda
é dado pessoal comum — nome, telefone e conteúdo de conversa são protegidos.

## 2. Minimização
- Não fiz varredura campo-a-campo exaustiva de uso, mas candidatos a **coletados e pouco/
  não lidos**: `jobs_ingestao.criado_por` e `prompt_versoes.criado_por` (gravados, não
  exibidos em nenhuma tela que eu tenha visto), e a tabela **`podcast_agendamentos`
  inteira** — PII de outra aplicação que o painel não lê nem usa. `tokens_entrada/saida`
  em `mensagens_log` só alimentam billing (uso legítimo).
- Nenhum excesso gritante além do `podcast_agendamentos` conviver no mesmo banco.

## 3. Direitos do titular (acesso, correção, portabilidade, eliminação)
**Nenhum fluxo de titular implementado** (não há export, "baixar meus dados", correção
por autoatendimento nem "excluir meus dados" para o cliente final).

O que o sistema consegue hoje:
- `removerAdmin` — apaga usuário do painel (auth + `usuarios_painel`). Cobre o admin.
- `excluirDocumento` — **soft delete** dos chunks (`deletado_em`); o **arquivo no Storage
  permanece** (é a fonte da verdade, por design).
- `excluirTenant` — **soft delete** do tenant (`deletado_em` + zera account_id/token).

**Onde o dado da pessoa SOBREVIVE a um "delete" (eliminação incompleta):**
1. **Excluir um tenant NÃO apaga** `conversas`, `mensagens_log` (telefone + conteúdo!),
   `kb_documentos`, `uso_ingestao`, `prompt_versoes`, `jobs_ingestao` daquele tenant — só
   marca a linha de `tenants`. Os dados do cliente final ficam indefinidamente.
2. **Arquivos no Storage** persistem após "excluir documento".
3. **n8n/Redis** — buffers de memória por conversa persistem (só somem via "limpar
   memória").
4. **Chatwoot** — as conversas originais continuam lá (sistema externo).
5. **OpenAI** — conteúdo enviado para embedding/completion (retenção ~30 dias pela API).
6. **Backups do Supabase** — retêm o dado "excluído" pela janela de backup.
7. **Git público** — PII no histórico.
8. **Logs** (Supabase auth, hosting) — email/IP retidos pela retenção da plataforma.
> Não existe um "erase" que propague por todas essas superfícies. Um pedido de exclusão
> hoje seria atendido **parcialmente e manualmente**.

## 4. Retenção
**Nenhuma política de retenção em código.** `mensagens_log` é explicitamente "permanente"
(auditoria/billing). `conversas`, `kb_documentos` etc. não têm TTL nem job de expurgo.
Soft-deletes (`deletado_em`) **nunca são purgados fisicamente**. Dado fica indefinidamente.

## 5. Criptografia
- **Em trânsito:** HTTPS imposto (Supabase, validação Chatwoot exige HTTPS, n8n/OpenAI/
  SMTP sobre TLS). ✅
- **Em repouso:** criptografia de disco da plataforma (Supabase/Storage) — padrão. **Não
  há criptografia a nível de campo/aplicação.**
- **Texto puro (sensível):** `mensagens_log.conteudo` (conteúdo de conversa) e
  `conversas.phone` estão em plaintext no banco (protegidos só por disco + RLS).
  `tenants.chatwoot_token` (credencial) em plaintext — achado S1. Senhas de admin têm hash
  (GoTrue/bcrypt) ✅.

## 6. Subprocessadores — o que cada um recebe

| Serviço | Papel | Dados pessoais que recebe |
|---|---|---|
| **Supabase** (Postgres/Auth/Storage/Edge) | Infra principal | **Tudo** — nome/telefone/conteúdo do cliente final, email/senha do admin, arquivos |
| **OpenAI** | Embeddings + chat | `kb_documentos.text` (embeddings) + conteúdo das mensagens + system_prompt (via n8n). PII se o conteúdo tiver. |
| **n8n** (VPS `vps.sucinta.com.br`?) | Orquestração do agente | conteúdo de mensagem, telefone, config do tenant, `chatwoot_token` |
| **Redis** (lado n8n) | Memória do agente | buffers de conversa (conteúdo) por tenant/conversa |
| **Chatwoot** (`app.chatyou.chat`) | Origem das conversas | contatos (nome+telefone), mensagens — todo o dado do cliente final |
| **WAHA** (WhatsApp HTTP API) | Aviso de handoff | número `destino` + texto do aviso |
| **SMTP `mail.estudyou.com`** | Emails de auth | email do admin (reset de senha, convite) |
| **Vercel e/ou Coolify (VPS)** | Hospedagem | IP, URL, email do admin nos fluxos de auth (logs) |
| **GitHub** (repo público) | Código-fonte | PII no histórico (telefone) |
| Analytics / Sentry / APM | — | **Nenhum** (confirmado: sem SDK no código) ✅ |

## 7. Rastreabilidade (accountability)
**Não há log de acesso a dado pessoal no nível da aplicação.** `mensagens_log` é log de
mensagens do agente, não de acesso. Um `tenant_admin` que abre a conversa de um cliente
final e lê nome/telefone/mensagens **não deixa nenhum rastro**. Há rastreabilidade parcial
de **criação** (`criado_por` em jobs/prompt_versoes), não de **leitura**. Os logs do
Supabase (auth/API gateway) têm IP/timestamp, mas não "quem leu qual linha". **Lacuna real
de accountability da LGPD.**

## 8. Consentimento e avisos
- **No painel:** nenhum aviso de privacidade, política, ToS ou banner — não há tela de
  consentimento (é ferramenta B2B; o admin faz login).
- **Cliente final:** não interage com este app (fala com o bot no WhatsApp); o aviso/
  consentimento dele seria no canal do cliente (Chatwoot/WhatsApp), fora daqui.
- **`podcast_agendamentos`:** formulário público coleta nome/empresa/WhatsApp — o aviso de
  consentimento (se existe) está fora deste repositório.
- **Nenhum registro de consentimento** é armazenado em lugar nenhum.

---

## Gaps classificados por risco

| Risco | Gap | Por quê |
|---|---|---|
| **Alto** | Exclusão incompleta (dado sobrevive em ≥8 lugares) | Um pedido de eliminação (art. 18 LGPD / art. 17 GDPR) não é atendível de forma completa nem automática. |
| **Alto** | Sem rastreabilidade de acesso a dado pessoal | LGPD exige demonstrar quem acessou o quê; hoje impossível. |
| **Alto** | Conteúdo de conversa + telefone em texto puro, sem retenção | Dado de cliente final indefinidamente, sem expurgo nem cripto de campo. |
| **Médio** | `chatwoot_token` em plaintext (S1) | Credencial exposta (fix em branch). |
| **Médio** | PII de conversa vai à OpenAI/n8n sem controle de conteúdo | Envio de PII a subprocessador de IA sem redação/opt-out visível. |
| **Médio** | Sem política de retenção em código | Retenção indefinida viola minimização/necessidade. |
| **Médio** | PII no histórico do Git público | Exposição contínua e fora de controle. |
| **Médio** | `podcast_agendamentos` (PII de outra app) no mesmo banco | Blast-radius; finalidade distinta no mesmo processador. |
| **Baixo** | Sem aviso de privacidade no painel | B2B, mas ausência total de política/aviso é gap formal. |
| **Baixo** | Campos `criado_por` possivelmente não usados | Minimização. |

---

## Perguntas que um cliente ou auditor faria e que eu NÃO consigo responder hoje

1. **Em que região/país os dados do Supabase estão hospedados?** (residência de dados;
   transferência internacional). Não é determinável pelo código.
2. **Há DPA (contrato de operador) assinado com Supabase, OpenAI, Chatwoot, WAHA e com o
   provedor do VPS/n8n?** E uma lista pública de subprocessadores?
3. **A OpenAI está sob termos que garantem não-treinamento e/ou Zero Data Retention?**
   (A API padrão não treina, mas isso precisa ser confirmado contratualmente.)
4. **Onde o n8n roda, quem tem acesso ao servidor/Redis, e o Redis tem TTL** nos buffers de
   conversa?
5. **Qual a janela de retenção dos backups do Supabase** e eles contêm dados já "excluídos"?
   Há processo para expurgá-los sob pedido de eliminação?
6. **Qual a base legal** de cada tratamento (execução de contrato? legítimo interesse?) e o
   papel controlador/operador está formalizado com cada cliente?
7. **Existe processo (mesmo não-código) para responder a um pedido de titular no prazo
   legal** (15 dias, LGPD)? Quem executa e como?
8. **Os clientes (empresas) coletaram consentimento/aviso dos titulares finais** cujas
   conversas o painel processa? A ChatYou tem como exigir/registrar isso?
9. **Há DPO/encarregado designado** e canal de contato do titular?
10. **Os logs da Vercel/Coolify e do Supabase contêm PII** (IP, email) e qual a retenção
    deles? Não auditei o conteúdo dos logs de runtime em produção.

### Nota de método
Inventário e subprocessadores vêm do schema (verificado no banco) e das integrações lidas
no código. Não tenho acesso a contratos, configuração de hosting/região, nem à retenção de
backups — por isso o que depende disso está na seção de perguntas em aberto, não afirmado.
