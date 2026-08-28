# Pendências — o índice

Cada pendência tem arquivo próprio (`PENDENCIA-*.md`), com o motivo, o que
precisaria ser feito e **o gatilho que a retoma**. Esta página existe para
responder "o que está em aberto?" sem abrir nove arquivos.

**Regra que vale para todas:** pendência sem gatilho vira lista morta. Se um
item aqui não disser *quando* voltar a ele, ou o gatilho está faltando ou o item
já não é pendência.

| pendência | do que se trata | gatilho |
|---|---|---|
| [Status da conversa](PENDENCIA-STATUS-CONVERSA.md) | `'resolvido'` nunca é escrito; o painel mostra conversa encerrada há meses como `ativo` (as 66 da Acqua) | depois da demonstração do `emporio` |
| [Pergunta sem resposta](PENDENCIA-PERGUNTA-SEM-RESPOSTA.md) | não há como saber o que perguntaram e o agente não soube responder — a única métrica que diria **o que fazer** | quando alguém pedir, ou quando uma base parar de crescer |
| [Fatura da OpenAI](PENDENCIA-FATURA-OPENAI.md) | como a fatura entra no sistema todo mês; inclui a discussão em aberto sobre cobrar o prompt do cliente | quando a cobrança por consumo for faturar de verdade |
| [Piso de similaridade](PENDENCIA-PISO-SIMILARIDADE.md) | a busca sempre devolve algo, nunca "não tenho isso" — e as faixas de relevante e irrelevante se sobrepõem | cliente com base grande **e** resposta fora de contexto |
| [Relogio da expiracao de pedido](PENDENCIA-EXPIRACAO-PEDIDO.md) | qualquer `update` em `pedidos` reseta as 24h — uma correcao de dado ressuscitou um pedido ja vencido em 21/08; e a expiracao e preguicosa: cliente que nao volta deixa `aguardando_pagamento` para sempre | primeira reclamacao de pedido que sumiu ou ficou pendente para sempre; ou ao mexer em algo que escreva em `pedidos` |
| [Expirar rascunho](PENDENCIA-EXPIRAR-RASCUNHO.md) | carrinho abandonado reaparece na conversa seguinte | reclamação de pedido velho, ou volume |
| [Categoria de produto](PENDENCIA-CATEGORIA-PRODUTO.md) | "o que vocês têm?" responde por `order by nome` | próxima fatia de vendas |
| [Guarda do Storage](PENDENCIA-GUARDA-STORAGE.md) | a guarda de dado alheio cobre 14 tabelas e não o Storage | primeiro cliente além do `restaurante-teste` com foto |
| [Seed dos testes](PENDENCIA-SEED-DOS-TESTES.md) | **parcial** — os cinco de isolamento fecharam; outros nove ainda resolvem seed por slug | antes de apagar qualquer seed |
| [Exclusão atômica](PENDENCIA-EXCLUSAO-ATOMICA.md) | excluir cliente são duas escritas PostgREST e não uma transação; a ordem foi invertida para o resto possível ser visível, mas resto ainda existe | depois da demonstração do `emporio`, ou ao excluir cliente com credencial real |
| [Carrinho multi-item](PENDENCIA-CARRINHO-MULTI-ITEM.md) | a IA relata falha que nao houve ao somar 3 itens numa mensagem, re-adiciona, e o `on conflict` SOMA em vez de definir — cobrou R$ 30 a mais num pedido real (dado JA corrigido; o defeito NAO) | antes de qualquer cliente novo de vendas — e a §2b mostra que prompt sozinho nao resolve |
| [`podcast_vagas`](PENDENCIA-PODCAST-VAGAS.md) | duas camadas ausentes juntas: `anon` tem `arwdDxtm` na view E na base, e a view nao tem `security_invoker`. Nao vaza hoje **porque o `select` so expoe agregado** — simulado: uma coluna `a.nome` a mais entrega nomes reais a `anon` na hora. E o conserto obvio (`revoke` + `security_invoker`) **quebra a pagina em silencio**, mostrando 6 vagas livres em todo dia | confirmar com quem mantem a app do podcast se a pagina le como `anon`; e o gatilho mecanico e um teste que varre views sem `security_invoker` |
| [Rastro da anomalia](PENDENCIA-RASTRO-DA-ANOMALIA.md) | `conversas` nao tem coluna de metadados, entao a pausa por anomalia (migracao 53) deixa como unico rastro o `motivo_pausa`. Nao fica gravado qual regra disparou, qual texto repetia, nem quantas vezes. O log tem tudo e a notificacao carrega o texto — o que resolve UMA investigacao a mao, e nao "quantas anomalias tivemos este mes" | se virar recorrente: segunda ou terceira conversa pausada por anomalia em clientes diferentes |
| [Auto-casamento por CRLF](PENDENCIA-AUTOCASAMENTO-CRLF.md) | `teste:comparacoes-tipo` acusa o PROPRIO comentario que explica a armadilha. A protecao contra auto-casamento existe e esta certa — quebrou porque o arquivo virou CRLF e em JS `.` nao casa `
| [Normalizar fim de linha](AMBIENTE-WINDOWS.md) | `core.autocrlf=true` no git do sistema e nenhum `.gitattributes`: a working copy oscila entre CRLF e LF e mata varredor sem aparecer em diff. Medido: o INDICE ja e LF em 357 de 371, entao normalizar muda de verdade so 2 arquivos (`CLAUDE.md` e este indice, que tem CRLF gravado no blob) mais 1 de fim misto | primeiro dia SEM import pendente, em commit proprio e sozinho |
`, entao `/\/\/.*$/` nao strippa comentario nenhum. Ninguem editou nada; o git mudou o fim de linha e a guarda morreu sem aparecer em diff | agora: e o unico vermelho da suite que e defeito de teste, e o conserto e uma linha |
| [Credencial do teste de foto](PENDENCIA-FOTO-CREDENCIAL-ARRANJO.md) | `teste:migracao-foto` exige que `api_n8n_enviar_foto` devolva a credencial do Chatwoot, mas nao ARRANJA a credencial — e so 3 dos 8 tenants vivos tem token. Estado do mundo pela decima vez, no mesmo arquivo que ja produziu o oitavo caso da serie | junto com o item do CRLF: sao os dois unicos vermelhos da suite |
| [Caixa sem validação](PENDENCIA-CAIXA-SEM-VALIDACAO.md) | o `inbox_id` entra no painel como número livre: o token guardado é de Agent Bot e a API do Chatwoot responde **401** em `/accounts/{id}/inboxes` (medido nos três conectados), então errar o número não dá erro — dá agente mudo, calado. Segura hoje uma frase na tela que nomeia a consequência | **antes do quarto tenant conectado** — o argumento que justifica não validar é "sou eu digitando, três vezes", e ele para de valer por contagem, não por data |
| [Cliente x agente](PENDENCIA-CLIENTE-X-AGENTE.md) | a 54 fez dois agentes caberem numa conta do Chatwoot, mas um cliente com dois agentes continua sendo DOIS tenants: catálogo e KB em dobro, dois logins, consumo separado. O `chatwoot_inbox_id` que ela introduziu é o discriminador que a modelagem certa vai usar — nada se perde | primeiro cliente que reclamar de cadastrar em dobro, ou que precisar de fatura única |
| [Margem](PENDENCIA-MARGEM.md) | **decidido não fazer** — margem por cliente em `/admin/consumo` | planos diferentes entre clientes |

Duas que **não** são pendência e vivem aqui perto, para não se procurar no lugar
errado: [`ESPEC-TRANSFERIR-PARA-TIME.md`](ESPEC-TRANSFERIR-PARA-TIME.md) é
desenho aprovado em construção, e
[`AUDITORIA-PAINEL-CLIENTE.md`](AUDITORIA-PAINEL-CLIENTE.md) tem itens de
interface que sobraram, com prioridade dentro do próprio arquivo.
