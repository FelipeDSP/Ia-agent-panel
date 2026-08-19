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
| [Expirar rascunho](PENDENCIA-EXPIRAR-RASCUNHO.md) | carrinho abandonado reaparece na conversa seguinte | reclamação de pedido velho, ou volume |
| [Categoria de produto](PENDENCIA-CATEGORIA-PRODUTO.md) | "o que vocês têm?" responde por `order by nome` | próxima fatia de vendas |
| [Guarda do Storage](PENDENCIA-GUARDA-STORAGE.md) | a guarda de dado alheio cobre 14 tabelas e não o Storage | primeiro cliente além do `restaurante-teste` com foto |
| [Seed dos testes](PENDENCIA-SEED-DOS-TESTES.md) | **parcial** — os cinco de isolamento fecharam; outros nove ainda resolvem seed por slug | antes de apagar qualquer seed |
| [Exclusão atômica](PENDENCIA-EXCLUSAO-ATOMICA.md) | excluir cliente são duas escritas PostgREST e não uma transação; a ordem foi invertida para o resto possível ser visível, mas resto ainda existe | depois da demonstração do `emporio`, ou ao excluir cliente com credencial real |
| [Margem](PENDENCIA-MARGEM.md) | **decidido não fazer** — margem por cliente em `/admin/consumo` | planos diferentes entre clientes |

Duas que **não** são pendência e vivem aqui perto, para não se procurar no lugar
errado: [`ESPEC-TRANSFERIR-PARA-TIME.md`](ESPEC-TRANSFERIR-PARA-TIME.md) é
desenho aprovado em construção, e
[`AUDITORIA-PAINEL-CLIENTE.md`](AUDITORIA-PAINEL-CLIENTE.md) tem itens de
interface que sobraram, com prioridade dentro do próprio arquivo.
