# Política de retenção de dados

> Decidida pelo Felipe em 16/09/2026: **global, 45 dias de texto** ("não temos
> infra para guardar tanto"). Mecanismo: migração 67 (`api_agente_retencao`)
> chamada uma vez por dia pela manutenção do serviço `agente/`; o painel mostra
> a mesma janela (`src/lib/retencao.ts`).

## O princípio

Guardar é a opção mais cara: custa banco, custa LGPD (texto de conversa é dado
pessoal) e custa a chance de um vazamento levar anos de histórico. Cada tabela
guarda **pelo tempo em que alguém precisa dela**, e nem um dia a mais. A fonte
de registro das conversas é o **Chatwoot** — o painel nunca exibiu o texto das
mensagens, só a lista.

## Os prazos

| dado | para que serve | prazo | como |
|---|---|---|---|
| texto das mensagens (`mensagens_log.conteudo`, `portao`, `saida_cortes`) | memória do agente (40 min / 20 pares), auditoria do portão | **45 dias** | vira NULO; a linha fica |
| contagem das mensagens (tokens, fonte, chamadas) | consumo do mês, cobrança | **400 dias** (~13 meses) | a linha é apagada |
| trace (`agente_turnos` + `agente_passos`), fila concluída | diagnóstico | **45 dias** (passos: 30) | apagados; turno `aberto` e fila `pendente` ficam (são do alarme de mudo) |
| identidade da conversa (`conversas.contact_name`, `phone`) | lista do painel, pausa, corte de memória | **180 dias sem mensagem** | vira NULO; a linha fica (é a chave da pausa) |
| pedidos, itens, cobranças, eventos de pagamento | registro financeiro | **não se apaga** | — |
| base de conhecimento, prompt, catálogo de produtos | conteúdo que o cliente administra | é dele apagar | — |

A regra interna que a função impõe: `contagem ≥ texto` — apagar a linha antes
de tirar o texto dela sumiria com o consumo do mês corrente.

## Onde os números moram

- Serviço: env `RETENCAO_TEXTO_DIAS` (45), `RETENCAO_TURNOS_DIAS` (45),
  `RETENCAO_CONTAGEM_DIAS` (400), `RETENCAO_CONVERSAS_DIAS` (180) — defaults em
  `agente/src/manutencao.ts` (`RETENCAO_PADRAO`). `TRACE_RETENCAO_DIAS` (30)
  continua sendo o dos passos.
- Painel: `src/lib/retencao.ts` (`RETENCAO_TEXTO_DIAS = 45`) — a lista de
  conversas do cliente e do admin só mostram a janela. Relatórios já eram 30 dias.
- Global de propósito. Se um cliente exigir prazo próprio, vira coluna em
  `tenants` (agência-only, como a 66) e a função passa a receber por tenant.

## O que a primeira passada vai fazer

Em 16/09/2026 o banco tinha 12.493 linhas em `mensagens_log` (21 MB) desde
maio, nunca apagadas. A primeira execução da retenção tira o texto de tudo
com mais de 45 dias (a maior parte) e apaga o que tem mais de 400 (o começo do
Acqua). É irreversível por desenho — não há backup "de antes" fora do que o
Supabase guarda no plano.

## Verificação

`npm run teste:migracao-retencao` — três tenants, datas arranjadas, cada corte
medido, financeiro intacto, idempotência, `n8n_agent` chamando, sabotagem que
apagaria turno aberto. A passada diária registra as contagens no log do
serviço (`manutencao.retencao_dados`).
