# `n8n/importar/` — JSON pronto para importar, e NÃO a fonte da verdade

A fonte versionada dos workflows é `n8n/workflows/`. **Esta pasta é outra coisa:**
cada arquivo aqui é o resultado de aplicar UMA mudança estrutural sobre um EXPORT
recente da instância, para ser importado e depois descartado.

## Por que não sai de `n8n/workflows/`

Porque o repositório e a instância divergem em coisas que **não** são a mudança que
se quer entregar. Em 2026-08-20, o `Estima Tokens` do repo estava 30 linhas à frente
da instância (correção de comentário de 18/08 gerada e nunca importada). Gerar o JSON
a partir do repo faria a importação mudar **duas** coisas — o roteamento da pausa e o
comentário do `Estima Tokens` — e um rollback teria de desfazer as duas juntas.

Partindo do export, o import muda exatamente uma coisa e o rollback é reimportar o
export.

## O ciclo

```
1. exportar o workflow pela UI do n8n            (... -> Download)
2. node scripts/aplicar-conserto-pausa.mjs --export <arquivo baixado>
3. node scripts/n8n-validar.mjs n8n/importar/<saida>.json
4. npm run teste:pausa
5. importar o JSON no n8n, conferir RECARREGANDO a pagina
6. exportar de novo e atualizar n8n/workflows/agente-principal.json
   (é este passo que devolve a mudança para a fonte versionada)
```

O passo 6 não é opcional: enquanto ele não acontece, `npm run n8n:diff` acusa a
diferença — que é o comportamento certo, porque a instância REALMENTE está diferente
do repo.

## Por que o export precisa dos parâmetros repostos

O n8n **omite no export todo parâmetro cujo valor bate com o default do node**. Três
deles não podem valer por default (o teto de uma resposta por mensagem, LPOP x RPOP, e
o nome do binário que a transcrição consome) — `scripts/n8n-validar.mjs` barra o
export cru por causa disso, e o script de conserto os repõe. Ver `n8n/README.md`,
seção "O export do n8n OMITE parâmetro em default".

## Conteúdo

| arquivo | o que muda | estado |
|---|---|---|
| `agente-principal-pausa.json` | roteamento da pausa automática: remove a `ev7`, renomeia `E Humano ou Dispositivo?` para `Fala com o Cliente?`, dá destino à saída falsa, protege o payload sem `sender` | **não importado** |
