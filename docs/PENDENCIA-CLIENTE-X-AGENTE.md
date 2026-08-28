# Pendência — a modelagem que separa CLIENTE de AGENTE

**Gatilho: o primeiro cliente que reclamar de manter catálogo/KB em dobro, ou o
primeiro que precisar de uma fatura só.** Um dos dois; não é data.

Aberto em 2026-08-28, junto com a migração 54 (roteamento por conta + caixa).

---

## O que a 54 resolveu, e o que ela não resolveu

**Resolveu:** um cliente com dois agentes deixa de precisar de duas **contas**
no Chatwoot. Duas caixas da mesma conta bastam, porque o bot do Chatwoot é
ligado a uma inbox e o roteamento passou a casar pelo par `(conta, caixa)`.

**Não resolveu:** um cliente com dois agentes continua sendo **dois tenants**.
Isso foi aceito conscientemente, e o preço é conhecido:

- catálogo e base de conhecimento **duplicados** — cadastro feito duas vezes,
  e as duas cópias divergem sozinhas com o tempo;
- **dois logins** para a mesma pessoa;
- consumo **separado** em vez de somado — dois números onde a conversa comercial
  é sobre um.

## Por que foi aceito assim

Porque a alternativa é a modelagem certa, e ela é fatia grande: um nível novo
acima de `tenant` (chame de `cliente` / `conta`), com `tenants` virando algo
como `agentes`. Isso toca **toda** tabela que hoje escopa por `tenant_id` — as
regras de multi-tenancy inteiras do `CLAUDE.md` —, o JWT (`app_metadata`), as
policies de RLS, e as 22 funções `api_n8n_*`.

Não é o tipo de coisa que se faz junto com roteamento. E fazer o roteamento
antes não custou nada à modelagem futura, que é o ponto seguinte.

## O que a 54 já deixou pronto para ela

**O `chatwoot_inbox_id`.** É exatamente o discriminador que a modelagem vai
precisar: quando `tenants` virar `agentes` pendurados num `cliente`, o que
distingue dois agentes do mesmo cliente é a caixa — que já está gravada, já vem
do webhook e já roteia. Nada do que a 54 fez precisa ser desfeito.

## O que ela deliberadamente NÃO adiantou

`conversas.inbox_id` e `mensagens_log.inbox_id`. A tentação é gravar desde já
para poder reconstruir "qual agente atendeu o quê". Motivo de não:

- **hoje seria dependência funcional.** Nesta modelagem cada tenant tem no
  máximo uma caixa, então `conversas.inbox_id` só repetiria o que o join com
  `tenants` já diz. A coluna só carrega informação depois desta pendência;
- **custa duas mudanças de aridade no caminho quente.**
  `api_n8n_conversa_sync` e `api_n8n_registrar_mensagem` são chamadas em toda
  mensagem, e a segunda é a assinatura com o pior histórico do repo (migrações
  32 e 37). Três mudanças de aridade numa fatia que precisa de uma;
- **o rastro não some no meio-tempo.** `mensagens_log.execucao_id` aponta para a
  execução do n8n, cujo payload tem `body.inbox.id`. Reconstruir é caro, não é
  impossível.

Quando esta pendência for feita, as colunas entram com o desenho **dela** — não
com o desenho de 2026-08-28.

## O que reler antes de começar

- `supabase/migrations/*_54_roteamento_por_caixa.sql` — o cabeçalho tem as
  medições que fixaram o par `(conta, caixa)` e por que o casamento é estrito;
- `CLAUDE.md`, seção *Regras de multi-tenancy* — as cinco regras que a modelagem
  nova precisa continuar cumprindo, em particular a 1 (`tenant_id` vem do JWT) e
  a 3 (`tenant_id` primeiro em índice composto);
- `docs/especificacao/ESPECIFICACAO.md` §3.2 — por que `tenants.id` é UUID e não
  `chatwoot_account_id`. O mesmo raciocínio vale um nível acima.
