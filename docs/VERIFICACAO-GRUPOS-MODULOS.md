# Verificação — grupos de módulo no painel

A regra, uma frase: **o painel do cliente só mostra o que ele pode agir.**
Não pode desligar nem configurar → some. Não tem contratado → some. Pode
configurar ou ligar/desligar → fica.

Três grupos, derivados de `contratavel` + `temConfigCliente` no registry
(`src/lib/tools/registro.ts`) — não há campo `grupo` para contradizer os dois:

| grupo | tools hoje | cliente vê | cliente pode |
|---|---|---|---|
| `padrao` | `busca_conhecimento`, `resolver_conversa` | nada | nada |
| `configuravel` | `transferir_humano` | card próprio | configurar **e** desligar |
| `contratavel` | `vendas`, `transcricao_audio`, `foto_produto` | só se contratado | ligar/desligar |

**"Pode desligar" NÃO é derivado de "é vendida."** São perguntas diferentes, e
confundi-las foi o defeito da primeira versão: `busca_conhecimento` não desliga
por limitação técnica (agente sem base responde do nada), `transferir_humano`
desliga por escolha de negócio (há cliente que não quer receber atendimento
transferido em momento nenhum). Ser vendida não responde nenhuma das duas.

Por isso `desligavel` é campo próprio no registry, e o teste declara grupo e
poder-desligar em **colunas separadas** — se saíssem um do outro, a asserção
seria eco da implementação.

Uma propriedade liga as duas: **quem pode desligar tem de aparecer.** Módulo
desligável e invisível é decisão do cliente sem lugar para ele tomar — foi
exatamente onde `transferir_humano` caiu quando o switch sumiu da tela.

---

## 1. A propriedade (não toca no banco)

```bash
npm run teste:grupos    # 57 checagens
```

Nenhuma asserção olha o estado do mundo. A do admin, em particular, é **"se
existe módulo padrão contratado e desligado, a seção abre"** — e não "não existe
módulo desligado". A segunda ficaria vermelha no dia em que alguém desligasse um
de propósito, que é operação legítima.

O teste importa o TypeScript direto (`tests/lib/resolver-ts.mjs`), em vez de
reimplementar a regra: teste que reimplementa o que testa concorda consigo mesmo
para sempre.

**Quatro sabotagens conferidas** — cada uma reprova o que deve:

| sabotagem | reprova |
|---|---|
| `transferir_humano` marcado como contratável | 4 asserções |
| `secaoPadraoTemAnomalia` sempre `false` | 2 |
| tool fora do registry cai em `padrao` | 2 |
| `clienteVeModulo` ignora o grupo | 2 |

> Achado ao sabotar: a primeira versão das seções 3 e 4 comparava o resultado
> contra `grupoTool(nome)`, e as funções **são definidas** em termos de
> `grupoTool` — tautologia, não conseguiam falhar. A SAB 1 reprovou 1 asserção
> onde devia reprovar 4. Hoje tudo compara contra `ESPERADO`, escrito à mão.

## 2. O estado real, sem abrir navegador

```bash
npm run modulos:visiveis
```

Imprime, por tenant, o que a tela do cliente renderiza e o que fica oculto,
aplicando as mesmas funções puras que as duas telas usam. Não afirma nada —
imprime estado. Serve para comparar **antes e depois** de mexer.

Saída de 13/08/2026, com as 15 linhas todas contratadas e ligadas:

```
acqua-lavanderia / clinica-teste / sandbox-de-testes
  painel do cliente:  transferir_humano  (formulário, sem switch)
  oculto:             busca_conhecimento, resolver_conversa

restaurante-teste
  painel do cliente:  foto_produto, transcricao_audio, vendas  (switch)
                      transferir_humano  (formulário, sem switch)
  oculto:             busca_conhecimento, resolver_conversa
```

Para 3 dos 4 clientes o card "Meus módulos" **não renderiza** — não há módulo
opcional, e lista vazia com "nenhum módulo contratado ainda" é ruído.

---

## 3. Exercitar o filtro que nunca rodou

O filtro de `contratado` existe no painel desde a §5.2 e **nunca escondeu nada**:
até 13/08/2026 não havia uma única linha com `contratado = false`. Isto é o
roteiro para vê-lo trabalhar.

**Use `restaurante-teste`. Nunca a Acqua** — ela roda no mesmo workflow.

### Antes

```bash
npm run modulos:visiveis
```

Anote as 4 linhas do `restaurante-teste` no painel do cliente.

### Descontratar

Admin → `restaurante-teste` → **Módulos** → **Descontratar** em *Enviar foto do
produto*.

`definirContratacao` mantém a linha e só vira `contratado` para `false` — a
config fica guardada, e `api_n8n_enviar_foto` continua encontrando a linha para
responder `nao_contratado`. **Nada é removido de `tenant_tools`.**

### Depois — as três coisas que precisam acontecer

1. **`npm run modulos:visiveis`**: `foto_produto` sai do bloco "painel do
   cliente" e aparece em "oculto do cliente" com motivo `não contratado`.
2. **Painel do cliente** (entre na conta do `restaurante-teste`) → Configurações:
   o card "Meus módulos" agora lista **2** módulos, sem *Enviar foto do produto*.
3. **O servidor recusa por baixo da tela.** Some o switch, mas a regra também
   vale para chamada direta — `alternarModulo` exige linha contratada:

   ```
   Este módulo não está incluído no seu plano. Fale com a agência.
   ```

### Exercitar o grupo, não só o contratado

O item 3 acima testa `contratado`. Para ver a regra **de grupo** trabalhar, o
alvo é outro: no console do navegador, logado como `restaurante-teste`, tente
desligar um módulo padrão. A tela não oferece o botão, e o servidor recusa
mesmo assim:

```
Este módulo é padrão do produto e não pode ser desligado.
```

É a diferença entre esconder o botão e não poder. Sem esse guard a regra seria
decorativa — mesma classe do `tool_ativa` que ninguém checava e do
`config_tool` que ignorava `contratado`.

### Voltar

Admin → **Contratar** de novo. `definirContratacao` preserva `config` e `ativo`,
então o cliente recupera exatamente o que tinha.

---

## 4. A seção recolhida do admin

Ela **abre sozinha** quando há módulo padrão contratado e desligado, e mostra
quantos. Para ver:

```sql
-- num tenant de TESTE, nunca na Acqua
update public.tenant_tools set ativo = false
 where tenant_id = '<restaurante-teste>' and tool_nome = 'resolver_conversa';
```

Admin → o cliente → Módulos: a seção "Padrão do produto" vem aberta, com
`· 1 desligado` no cabeçalho e o aviso de que o cliente não vê nem consegue
religar.

Reverter: `update ... set ativo = true`.

O motivo de a seção abrir: módulo padrão desligado é invisível para o cliente
**e irrecuperável por ele** — ele não tem mais o switch. Só a agência conserta,
e só conserta o que vê. Seção recolhida que esconde problema é a forma mais
rápida de um diagnóstico não acontecer.

---

## 5. Tool no catálogo sem entrada no registry

Cai em `contratavel` de propósito: um módulo recém-vendido precisa aparecer e ser
desligável antes de alguém escrever o rótulo. O admin mostra aviso âmbar na linha
— porque isso se descobre pela **ausência**, e ausência não avisa.

Para ver: Admin → Catálogo → crie uma tool com `tool_nome` novo, e abra qualquer
cliente. A linha aparece com o texto do catálogo e o aviso apontando
`src/lib/tools/registro.ts`.
