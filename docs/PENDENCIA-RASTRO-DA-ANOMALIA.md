# Pendência — a pausa por anomalia não deixa rastro de POR QUÊ

**Estado:** limitação aceita e declarada na migração 53 (2026-08-24). Nada
quebrado; falta informação.

**Gatilho:** **se virar recorrente.** Enquanto for um caso a cada tanto, o log
resolve. Na segunda ou terceira conversa pausada por anomalia em clientes
diferentes, a investigação vai custar mais do que a coluna.

## O que existe hoje

`conversas` tem exatamente estas colunas:

```
id, tenant_id, conversation_id, contact_name, phone,
status, pausado_em, criado_em, atualizado_em, motivo_pausa
```

**Não há campo de metadados.** Quando o portão pausa por anomalia, o único
rastro que fica na linha é `motivo_pausa = 'anomalia'` e o `pausado_em`. Não
fica gravado:

- qual regra disparou (hoje só existe uma, mas a própria migração 53 declara a
  troca disponível para `≤2 distintas nas últimas 5`);
- qual era o texto que estava repetindo;
- quantas repetições havia;
- quem era o outro lado.

## Por que isso é aceitável no primeiro corte

Duas razões, e as duas têm prazo de validade:

1. **O log tem tudo.** `mensagens_log` guarda `conteudo`, `direcao` e
   `criado_em` por conversa, e o índice `idx_log_conversa`
   (`tenant_id, conversation_id, criado_em`) torna a reconstrução barata:

   ```sql
   select criado_em, direcao, conteudo
     from public.mensagens_log
    where tenant_id = '<uuid>' and conversation_id = <id> and direcao = 'entrada'
    order by criado_em desc limit 20;
   ```

2. **A notificação carrega o texto.** O dono recebe no WhatsApp a última
   mensagem recebida, então a pergunta "o que estava repetindo?" já chega
   respondida a quem vai olhar.

O prazo de validade das duas é o mesmo: elas funcionam para **uma** conversa
investigada à mão. Não funcionam para "quantas anomalias tivemos este mês, e de
que tipo".

## O que fazer quando o gatilho bater

A saída provável é uma coluna `metadados jsonb not null default '{}'` em
`conversas`, escrita pelo portão no mesmo `update` que já faz a pausa — custo
marginal zero, porque a linha já está sendo escrita.

Dois cuidados que já se conhecem:

- **`conversas` tem RLS com policy e é lida pela view `conversas_painel`.**
  Coluna nova não entra na view sozinha; se tiver de aparecer na tela, a view
  precisa ser recriada (e `security_invoker` junto — ver
  `npm run teste:views-invoker`);
- **não repetir o erro do `atualizado_em`.** Um campo com dois significados é o
  defeito 1 de `PENDENCIA-EXPIRACAO-PEDIDO.md`. `metadados.anomalia` deve
  guardar o diagnóstico daquela pausa e nada mais.

## O que NÃO é este item

Não é sobre o teto de consumo. Aquele **já tem** rastro próprio e estruturado:
`alertas_consumo (tenant_id, dia, tipo, tokens_dia, teto, criado_em)`, com
unicidade em `(tenant_id, dia, tipo)`. A assimetria é deliberada — o teto é
número, e número pede tabela; a anomalia é episódio, e episódio ainda cabe no
log.
