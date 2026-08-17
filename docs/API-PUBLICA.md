# Superfície Pública — funções e classes exportadas

> Data: **2026-08-06**. Levantamento por extração de AST-lite sobre `src/`, `scripts/`,
> `tests/` e `supabase/functions/`: todo `export function`, `export const <nome> = (` e
> `export class`, com assinatura e linha. **131 exports — 130 funções, 1 classe.**
> Nenhum arquivo do projeto foi alterado.

## Panorama

| Grupo | Exports | Natureza |
|---|---|---|
| `src/app/` | 68 | 31 **Server Actions**, 26 componentes client, 11 páginas/layouts |
| `src/lib/` | 28 | o núcleo reutilizável — auth, clientes Supabase, validação, integrações |
| `src/components/` | 23 | 3 componentes de app + 20 primitivos `ui/*` |
| `scripts/` | 11 | ferramental de operação (`.mjs`) — inclui a **única classe** |
| `src/middleware.ts` | 1 | entrypoint do Next |
| `tests/`, `supabase/functions/` | **0** | nada exportado — são entrypoints executáveis |

**Uma única classe em todo o projeto:** `ErroDeUso extends Error` em
`scripts/lib/env.mjs:48`. O resto é função pura ou async — não há hierarquia de classes,
nem serviço instanciado, nem herança. Para um projeto deste porte isso é um dado, não
uma lacuna: o estado vive no Postgres e no React, não em objetos de domínio.

**A distinção que mais importa neste levantamento** não é função vs classe, é
**exportado de arquivo `'use server'` vs o resto**. Os 31 exports de arquivos com
`'use server'` não são apenas funções: o Next os publica como **endpoints RPC
alcançáveis do navegador**. Qualquer pessoa com uma sessão pode invocá-los com os
argumentos que quiser, sem passar pela tela que os chama. São a superfície de ataque
real do painel — e por isso estão auditados um a um na §1.

---

## 1. Server Actions — os 31 endpoints RPC

Cada linha foi verificada quanto ao gate de autorização no corpo da função.

### `src/app/(app)/admin/acoes.ts` — 13 ações, todas `exigirSuperAdmin()`

| Linha | Assinatura | Gate |
|---|---|---|
| 28 | `criarTenant(_estado: EstadoAcao, fd: FormData): Promise<EstadoAcao>` | `exigirSuperAdmin` |
| 64 | `convidarAdminTenant(_estado, fd): Promise<EstadoAcao>` | `exigirSuperAdmin` |
| 166 | `removerAdmin(_estado, fd): Promise<EstadoAcao>` | `exigirSuperAdmin` |
| 200 | `editarNomeAdmin(_estado, fd): Promise<EstadoAcao>` | `exigirSuperAdmin` |
| 236 | `reenviarAcessoAdmin(_estado, fd): Promise<EstadoAcao>` | `exigirSuperAdmin` |
| 266 | `conectarChatwoot(_estado, fd): Promise<EstadoAcao>` | `exigirSuperAdmin` |
| 339 | `alternarSuspensaoTenant(_estado, fd): Promise<EstadoAcao>` | `exigirSuperAdmin` |
| 363 | `excluirTenant(_estado, fd): Promise<EstadoAcao>` | `exigirSuperAdmin` |
| 416 | `editarTenantSuper(_estado, fd): Promise<EstadoAcao>` | `exigirSuperAdmin` |
| 446 | `salvarTransferirHumanoAgencia(_estado, fd): Promise<EstadoAcao>` | `exigirSuperAdmin` |
| 512 | `definirContratacao(_estado, fd): Promise<EstadoAcao>` | `exigirSuperAdmin` |
| 584 | `criarToolCatalogo(_estado, fd): Promise<EstadoAcao>` | `exigirSuperAdmin` |
| 624 | `editarToolCatalogo(_estado, fd): Promise<EstadoAcao>` | `exigirSuperAdmin` |

É o único módulo que importa `criarClienteAdmin()` (`service_role`). Todas as 13 ações
verificam o papel **antes** de qualquer leitura ou escrita — o que satisfaz a exceção da
regra 1 do `CLAUDE.md` (rota de super_admin pode receber `tenant_id` do request, desde
que confira o papel no servidor).

### `src/app/(app)/admin/consumo/precos/acoes.ts`

| Linha | Assinatura | Gate |
|---|---|---|
| 19 | `adicionarPreco(_estado: EstadoPreco, fd: FormData): Promise<EstadoPreco>` | `exigirSuperAdmin` |

### `src/app/(app)/painel/acoes.ts`

| Linha | Assinatura | Gate |
|---|---|---|
| 21 | `salvarConfigTenant(_estado: EstadoConfig, fd: FormData): Promise<EstadoConfig>` | `exigirTenantAdmin` |
| 54 | `salvarTransferirHumano(_estado: EstadoConfig, fd: FormData): Promise<EstadoConfig>` | `exigirTenantAdmin` |

### `src/app/(app)/painel/conhecimento/acoes.ts`

| Linha | Assinatura | Gate | Recebe id do cliente |
|---|---|---|---|
| 33 | `subirArquivo(_estado: EstadoIngestao, fd: FormData): Promise<EstadoIngestao>` | `exigirTenantAdmin` | |
| 97 | `ingerirTexto(_estado, fd): Promise<EstadoIngestao>` | `exigirTenantAdmin` | |
| 150 | `reprocessar(jobId: string): Promise<EstadoIngestao>` | `exigirTenantAdmin` | ✔ `jobId` |
| 183 | `excluirDocumento(origem: string): Promise<EstadoIngestao>` | `exigirTenantAdmin` | ✔ `origem` |
| 207 | `dispensarJob(jobId: string): Promise<EstadoIngestao>` | `exigirTenantAdmin` | ✔ `jobId` |
| 231 | `verConteudoDocumento(origem: string): Promise<{ chunks: ChunkConteudo[]; erro?: string }>` | `exigirTenantAdmin` | ✔ `origem` |
| 268 | `listarStatusJobs(): Promise<JobStatus[]>` | `exigirTenantAdmin` | |

### `src/app/(app)/painel/conversas/acoes.ts`

| Linha | Assinatura | Gate | Recebe id do cliente |
|---|---|---|---|
| 24 | `definirStatusConversa(conversationId: number, novoStatus: string): Promise<EstadoConversa>` | `exigirTenantAdmin` | ✔ |
| 75 | `limparMemoriaConversas(alvo: number[] \| 'todas'): Promise<EstadoConversa>` | `exigirTenantAdmin` | ✔ |

### `src/lib/tenants/prompt-acoes.ts` — as duas com gate mais fraco

| Linha | Assinatura | Gate | Recebe id do cliente |
|---|---|---|---|
| 14 | `salvarPrompt(tenantId: string, _estado: EstadoPrompt, fd: FormData): Promise<EstadoPrompt>` | `exigirUsuario` | ✔ `tenantId` |
| 48 | `restaurarVersaoPrompt(tenantId: string, versaoId: string): Promise<EstadoPrompt>` | `exigirUsuario` | ✔ `tenantId`, `versaoId` |

São as **únicas** Server Actions que recebem `tenantId` como parâmetro e gateiam apenas
com `exigirUsuario()` — que só confirma que existe alguém logado, sem dizer de qual
tenant. Lidas isoladamente parecem violar a regra 1 do `CLAUDE.md`. **Não violam**, e o
motivo está nas linhas seguintes ao gate:

```ts
if (usuario.papel === 'tenant_admin' && usuario.tenantId !== tenantId) {
  return { erro: 'Sem permissão para este cliente.' };
}
```

O `tenantId` do request é **comparado** com o do JWT, não confiado. A autoridade continua
sendo o JWT. `exigirUsuario` é o gate certo aqui justamente porque a função serve os dois
papéis (super_admin edita qualquer tenant, tenant_admin só o próprio) — um
`exigirTenantAdmin` quebraria o super. `restaurarVersaoPrompt` ainda faz uma segunda
checagem, confirmando que a versão pertence ao tenant (`versao.tenant_id !== tenantId`),
e por baixo de tudo a RLS é a terceira camada.

> Vale registrar como o ponto a reler em qualquer refatoração: **a segurança destas duas
> está no corpo, não na assinatura.** Se alguém trocar o gate por um helper diferente e
> remover o `if`, nada quebra visivelmente.

### `src/app/(auth)/acoes.ts` — públicas por natureza

| Linha | Assinatura | Gate |
|---|---|---|
| ~31 | `entrar(_estado: EstadoFormulario, dados: FormData): Promise<EstadoFormulario>` | `obterUsuarioAtual` (pós-login) |
| 69 | `sair(): Promise<void>` | **nenhum** — logout, inócuo sem sessão |
| 76 | `pedirRecuperacao(_estado, dados): Promise<EstadoFormulario>` | **nenhum** — precisa ser público |
| 101 | `definirNovaSenha(_estado, dados): Promise<EstadoFormulario>` | `supabase.auth.getUser()` direto |

As três sem `exigir*` são corretas: um endpoint de login/recuperação que exigisse sessão
seria inútil. `pedirRecuperacao` responde igual exista ou não a conta, para a tela não
virar oráculo de enumeração de emails. E `definirNovaSenha` **é** gateado — só que por
`getUser()` na mão, exigindo a sessão vinda do link de recuperação, em vez do helper
`exigir*`. Não aparece numa varredura por `exigir*`; aparece na leitura.

---

## 2. `src/lib/` — o núcleo (28 exports)

```ts
// auth.ts — o módulo mais importado do projeto (22 dependentes)
async obterUsuarioAtual(): Promise<UsuarioAtual | null>          // :19
async exigirUsuario(): Promise<UsuarioAtual>                     // :70
async exigirSuperAdmin(): Promise<UsuarioAtual>                  // :77
async exigirTenantAdmin(): Promise<UsuarioAtual & { tenantId }>  // :84

// supabase/server.ts · client.ts · admin.ts · middleware.ts — os 4 clientes
async criarClienteServidor()                                     // server.ts:9
     criarClienteBrowser()                                       // client.ts:8   [use client]
     criarClienteAdmin()                                         // admin.ts:8    service_role
async atualizarSessao(request: NextRequest)                      // middleware.ts:12

// supabase/admin-usuarios.ts — Admin API do Supabase
     criarUsuario(admin: SupabaseClient, params)                 // :34
     ehEmailDuplicado(error): boolean                            // :42
async acharPorEmail(admin, email, { tentativas, intervaloMs })   // :52

// tenants/schema.ts — validação de formulário, pura
     normalizarSlug(bruto: string): string                       // :25
     validarCriacaoTenant(fd): ResultadoValidacao<DadosCriacaoTenant>      // :69
     validarEdicaoTenantAdmin(fd): ResultadoValidacao<DadosEdicaoTenantAdmin>  // :103
     validarConfigTenantSuper(fd): ResultadoValidacao<DadosConfigSuper>    // :129

// tools/ — catálogo de tools
     definicaoTool(nome: string): DefinicaoTool | null            // registro.ts:33
     formatarDestino(bruto: string): string | null                // transferir-humano.ts:58
     numeroParaExibir(destino): string                            // transferir-humano.ts:76
     validarTransferirCliente(fd): Resultado<…>                   // transferir-humano.ts:91
     validarTransferirAgencia(fd): Resultado<…>                   // transferir-humano.ts:163

// integrações externas (todas server-only)
async validarCredencialChatwoot({ url, accountId, token, ehBot? }): Promise<ResultadoChatwoot>  // chatwoot.ts:10
async invocarProcessamento(jobId: string, texto?: string)         // ingestao.ts:6
async invocarLimparMemoria({ tenantId, escopo, conversationIds }) // n8n.ts:6

// utils.ts
     cn(...inputs: ClassValue[])                                  // :5
     formatarData(valor: string | null): string                   // :15
     formatarDataHora(valor: string | null): string               // :22

// tenants/prompt-acoes.ts  [use server] — ver §1
```

Observações sobre esta camada:

- **`validar*` é a família mais bem definida do projeto**: 6 funções, todas puras, todas
  `(fd: FormData) → Resultado<T>`, nenhuma tocando banco. É o que permite testar
  validação sem subir Supabase.
- **Os 4 clientes Supabase têm nomes simétricos** (`criarCliente{Servidor,Browser,Admin}`
  + `atualizarSessao`) e cada um mora no seu arquivo. `admin.ts` é o único com a chave
  secreta e o único importado por um só módulo.
- **`exigirTenantAdmin` é a única que estreita o tipo** (`UsuarioAtual & { tenantId: string }`),
  eliminando o `null`-check de `tenantId` em todo chamador. Bom uso do sistema de tipos.

## 3. `src/components/` (23 exports)

3 componentes de aplicação — `PromptEditor`, `Sidebar`, `ThemeToggle` (todos `use client`)
— e 20 primitivos em `ui/`: `Alert`, `Badge`, `Button`, `Card` + 5 subpartes, `Input`,
`Label`, `Select`, `SubmitButton`, `Table` + 5 subpartes, `Textarea`.

Todos seguem a mesma assinatura de props do shadcn (`{ className, ...props }: XProps`), e
só dois carregam `'use client'` (`SubmitButton`, que usa `useFormStatus`, e os 3 de app).
Os 20 primitivos são Server Components por padrão — é o que mantém o bundle pequeno.

## 4. `scripts/` (11 exports) — inclui a única classe

```js
// scripts/lib/env.mjs
     carregarEnv({ silencioso = false } = {})     // :9
class ErroDeUso extends Error                     // :48   <- unica classe do projeto
     exigirVariavel(nome, { minimo = 1 } = {})    // :50

// scripts/lib/usuarios.mjs — wrapper da Admin API, espelha lib/supabase/admin-usuarios.ts
     listarUsuarios(admin, params = { perPage: 1000 })          // :25
     criarUsuario(admin, params)                                // :29
     atualizarUsuario(admin, id, params)                        // :33
     removerUsuario(admin, id)                                  // :37
async acharPorEmail(admin, email, { tentativas, intervaloMs })  // :42
async removerPorEmail(admin, email, opcoes = {})                // :59
async removerPorId(admin, id)                                   // :69
     ehEmailDuplicado(error)                                    // :77
```

⚠️ **`criarUsuario`, `acharPorEmail` e `ehEmailDuplicado` existem duas vezes** — em
`scripts/lib/usuarios.mjs` (JS, para os scripts) e em `src/lib/supabase/admin-usuarios.ts`
(TS, para o app). Mesmos nomes, mesma semântica, duas implementações. O cabeçalho do
arquivo TS reconhece a duplicação e a documenta; é deliberada, porque os scripts `.mjs`
não podem importar do `src/` compilado. Vale saber que uma correção de bug precisa ser
aplicada nos dois lados.

## 5. Sem exports

`tests/*.mjs` (3 arquivos) e `supabase/functions/processar-ingestao/index.ts` não
exportam nada. Os testes são executáveis de topo; a Edge Function publica seu handler via
`Deno.serve(...)`, não por `export`. Correto para o que são — só significa que **nenhum
deles pode ser reaproveitado por import**, o que explica a duplicação do harness de teste
já apontada em `auditorias/AUDIT-DEBITO.md`.

---

## Método

Extração por regex sobre linhas iniciando com `export`, com acumulação de assinatura
multi-linha até a chave de abertura do corpo e remoção prévia de comentários. Assinaturas
longas aparecem truncadas com `…`; a linha citada é a fonte. O gate de cada Server Action
foi conferido buscando `exigir*`/`obterUsuarioAtual` no corpo delimitado pela função, e os
casos sem correspondência foram lidos à mão (é assim que `definirNovaSenha` foi
classificada corretamente).
