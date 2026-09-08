# Pendência — a regra de credencial do validador cobre 33 nós de 41

**Estado:** achado em 2026-09-08, ao escrever a regra do `sessionTTL`
(`PENDENCIA-VENDA-AFIRMADA-SEM-TOOL.md` §2.4). **Nada consertado.** É a mesma
família do `Consulta Pausa`, e o estrago é no import.

**Gatilho: a próxima janela de import**, que já está marcada para o
`tool-gerenciar-pedido.json` (§7 do `RETRATO-N8N-INSTANCIA-31-08.md`). Não é
urgência de runtime — é que a janela é o momento em que a falta de credencial
custa caro, e é quando alguém está olhando.

## O que a regra 8 faz, e o que ela não alcança

`scripts/n8n-validar.mjs` reprova nó sem credencial, mas só para dois tipos:

```js
const CRED_POR_TIPO = {
  'n8n-nodes-base.postgres': 'postgres',
  'n8n-nodes-base.redis': 'redis',
};
```

Varrendo os nove workflows de `n8n/workflows/` e contando **todo nó que hoje tem
credencial declarada**:

| tipo do nó | nós | credencial | coberto? |
|---|---:|---|---|
| `n8n-nodes-base.postgres` | 28 | `postgres` | **sim** |
| `n8n-nodes-base.redis` | 5 | `redis` | **sim** |
| `n8n-nodes-base.httpRequest` | 3 | `openAiApi`, `httpHeaderAuth` | **não** |
| `@devlikeapro/n8n-nodes-waha.WAHA` | 3 | `wahaApi` | **não** |
| `@n8n/n8n-nodes-langchain.lmChatOpenAi` | 1 | `openAiApi` | **não** |
| `@n8n/n8n-nodes-langchain.memoryRedisChat` | 1 | `redis` | **não** |

**33 cobertos, 8 descobertos.** Se qualquer um dos oito perder a credencial numa
geração futura, nada avisa — exatamente como o `Consulta Pausa`, que passou dez
dias sem credencial no repo e só apareceu por acaso, num diff contra a instância.

**E dois dos descobertos são os piores para perder:**

- o `Redis Chat Memory` é o único nó de memória. Sem credencial, o agente importa
  e roda **sem memória nenhuma**, silenciosamente — não quebra, degrada;
- o `OpenAI Chat Model` é o único modelo. Sem credencial, o agente não responde a
  ninguém. Esse pelo menos falha alto.

**Um terceiro que já divergiu na prática:** o `Assina URL` do `Tool - Enviar Foto
do Produto` é um `httpRequest`, e é onde repo e instância discordam de credencial
desde 31/08 (`PENDENCIA-SEGREDO-FOTO.md`). A regra 8 não olha para ele.

## O que não está decidido

1. **Estender o mapa** (`+4 linhas`) é o conserto óbvio e tem o defeito da lista
   fixa: tipo novo entra sem cobertura e ninguém nota. É o mesmo problema que o
   `teste:grants-n8n` resolveu varrendo `api_n8n_*` em vez de manter lista.
2. **Inverter a regra** — "todo nó que declara `credentials` tem de ter nome não
   vazio, e todo nó de um tipo que JÁ apareceu com credencial em algum workflow
   tem de ter" — deriva a lista do próprio repo, então tipo novo entra sozinho.
   O risco é o oposto: um nó legítimo sem credencial (um `httpRequest` público)
   viraria falso positivo, e a §6 do doc irmão já registra o que falso positivo
   faz com um detector.
3. **Quem decide o que é "legítimo sem credencial"** não está escrito em lugar
   nenhum hoje. Sem isso, a opção 2 não fecha.

Recomendação, para quando for decidir: **opção 2 com lista de exceção explícita**,
que é a forma que o projeto já usa em `ROTAS_SEMPRE_VISIVEIS` — a regra deriva do
mundo, a exceção é declarada e visível.

## Achado adjacente — o gerador MUTA o JSON, não o gera

Descoberto ao sabotar a regra nova do `sessionTTL`, e vale registrar porque
contradiz uma frase que este projeto vem repetindo.

`scripts/gerar-principal.mjs` começa com:

```js
const ARQ = path.join(RAIZ, 'n8n', 'workflows', 'agente-principal.json');
const w = JSON.parse(fs.readFileSync(ARQ, 'utf8'));
```

Ele **lê o próprio arquivo de saída e o muta em cima**, e depois reescreve. Não
gera do zero. Duas consequências, e a segunda não estava escrita em lugar nenhum:

- **a frase "o gerador reescreve o JSON, então conserto só no arquivo dura até a
  próxima geração" está certa só para SOBRESCRITA.** Vale para campo que o
  gerador seta. Para campo que ele **não** seta, o arquivo é a única fonte, e o
  valor sobrevive a todas as gerações;
- **portanto "tirar a linha do gerador e regerar" NÃO é sabotagem válida.**
  Foi a primeira que tentei: comentei
  `no('Redis Chat Memory').parameters.sessionTTL = 2400`, regerei, e o campo
  continuou lá — a mutação não entrou, e um observador desatento leria isso como
  "a regra não pega". A sabotagem que vale é **tirar o campo do JSON** e rodar o
  validador: aí ele sai com código 1 e a mensagem certa. Conferido nos dois
  sentidos, com o md5 do arquivo restaurado batendo com o de antes.

O risco que isso abre e que ninguém está medindo: **um campo posto à mão no
`agente-principal.json` sobrevive para sempre sem nunca aparecer no gerador.** É
deriva dentro do próprio repo, da mesma família da deriva contra a instância que
o `n8n:diff` caça — só que sem detector nenhum. O `n8n:sincronia` compara o
arquivo com o gerador, mas para o wrapper, não para o workflow inteiro.
