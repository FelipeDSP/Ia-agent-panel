# Pendência — `Limpar Memoria` está ativo, apaga Redis e não está versionado

**Estado:** achado em 2026-08-31, na varredura da instância do n8n. **Nada foi
feito** — a decisão é uma das três abaixo e é sua.

**Gatilho: agora.** É um webhook ativo, sem autenticação declarada no que se
inspecionou, apagando chave de Redis, e nenhuma cópia dele existe fora da
instância. Se a instância perder o workflow, ninguém reconstrói a partir do repo.

## O que é

```
Limpar Memoria (Webhook do Painel)     ATIVO     8 nós     atualizado 30/07
  Webhook /limpar-memoria
    -> Valida e Prepara (code)
    -> Busca Chaves (KEYS) (redis)
    -> Expande Chaves (code)
    -> Tem Chave? (if)
    -> Apaga Chave (redis)
    -> Responde OK / Responde Vazio
```

Está na mesma pasta dos nove workflows do agente (`Agente de ia`, projeto
`wb60X1hzUujDicl7`), e é o **décimo** — os nove do repo mais este.

## Os três fatos que o tornam pendência

1. **Não está em `n8n/workflows/`.** Os outros nove estão. Este nunca foi
   versionado, então `npm run n8n:diff` o reporta como "só na instância" e não
   tem com o que comparar. É a mesma classe da Edge Function que ficou dez dias
   fora do commit e do nome de migração fora do ledger — deriva por ausência,
   não por divergência.

2. **`src/` não tem nenhuma referência a ele.** A varredura
   (`grep -rn "limpar-memoria" src/ supabase/ docs/ n8n/ scripts/`) acha duas
   linhas, ambas em documentação: `docs/n8n/n8n-limpar-memoria.md` cita
   `N8N_LIMPEZA_URL=https://SEU_N8N/webhook/limpar-memoria`, e o índice do
   `docs/README.md` aponta para lá. **O painel não chama.** Ou a variável nunca
   foi ligada, ou quem chama é outra coisa, ou ninguém chama.

3. **Está ativo e escreve.** Os oito nós terminam num `Apaga Chave` do Redis.
   Workflow ativo com webhook é superfície exposta; workflow ativo que apaga é
   superfície exposta que destrói estado. Não medi quem pode chamar o webhook —
   isso é parte do item 3 abaixo.

## As três saídas, e o que cada uma custa

- **Versionar.** Exportar, gravar em `n8n/workflows/`, passar pelo
  `npm run n8n:validar` e pelo diff. Custa pouco e faz o `--completo` voltar a
  ser verdade (hoje ele afirma nove e a pasta tem dez ativos). É o caminho se o
  workflow tem uso.
- **Desativar.** Se ninguém chama — e `src/` sugere que ninguém —, um webhook
  ativo que apaga Redis é risco sem contrapartida. Desativar é reversível e
  imediato.
- **Documentar por que existe.** Se o uso é manual (alguém bate no webhook para
  limpar memória de um cliente), então falta escrever isso, e falta saber se o
  endpoint tem autenticação. `docs/n8n/n8n-limpar-memoria.md` descreve o
  mecanismo, não a decisão.

**A que não vale é deixar como está**, porque as três dependem de saber quem
chama, e essa pergunta não fica mais fácil com o tempo.

## O que medir antes de decidir

1. O `Webhook Limpar` tem autenticação? (header, query secreta, nada?)
2. Há execução recente dele no histórico da instância? Um mês sem execução
   responde a pergunta do uso.
3. `N8N_LIMPEZA_URL` existe em algum ambiente (Coolify, Vercel)? Se existir e
   `src/` não a lê, é variável órfã e vale sumir junto.
