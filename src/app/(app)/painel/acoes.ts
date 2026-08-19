'use server';

import { revalidatePath } from 'next/cache';

import { exigirTenantAdmin } from '@/lib/auth';
import { criarClienteAdmin } from '@/lib/supabase/admin';
import { criarClienteServidor } from '@/lib/supabase/server';
import { validarEdicaoTenantAdmin } from '@/lib/tenants/schema';
import { clientePodeDesligar } from '@/lib/tools/registro';
import { MAX_DESCRICAO_TOTAL, validarTime } from '@/lib/tools/times-chatwoot';
import { verificarTime } from '@/lib/tools/times-chatwoot.server';
import {
  TOOL_TRANSFERIR,
  validarTransferirCliente,
  type ConfigTransferir,
} from '@/lib/tools/transferir-humano';

export type EstadoConfig = {
  erro?: string;
  errosCampo?: Record<string, string>;
  sucesso?: string;
};

export type ResultadoModulo = { ok: true } | { ok: false; erro: string };

/**
 * Cliente liga/desliga um módulo contratado ("Meus módulos").
 *
 * SÓ CONTRATÁVEL. Padrão e configurável não têm switch na tela, e a checagem
 * está aqui porque esconder o botão não é o mesmo que não poder: sem este guard
 * uma chamada direta ainda desligaria `busca_conhecimento`, e o cliente ficaria
 * com o agente respondendo sem base de conhecimento e sem caminho de volta —
 * a tela dele não mostra mais o módulo. É a mesma classe do `tool_ativa` que
 * ninguém checava e do `config_tool` que ignorava `contratado`.
 *
 * Toca SOMENTE `ativo`. `contratado` é decisão comercial da agência e o trigger
 * tenant_tools_guard_colunas barra quem não é super_admin — mandar as duas
 * colunas juntas faria o guard reprovar o update inteiro, inclusive a parte
 * legítima.
 *
 * tenantId vem de exigirTenantAdmin (JWT), nunca do argumento — regra 1 do
 * CLAUDE.md. O filtro explícito por tenant_id é a primeira camada; a RLS de
 * tenant_tools é a segunda (regra 6). Um cliente do tenant A chamando esta ação
 * direto, com o tool_nome de um módulo do tenant B, atinge zero linhas: o filtro
 * é montado com o tenant DELE.
 */
export async function alternarModulo(
  toolNome: string,
  ativo: boolean,
): Promise<ResultadoModulo> {
  const usuario = await exigirTenantAdmin();

  // Forma do identificador. Barra string arbitrária vinda do cliente antes de
  // ela virar filtro de query. NÃO exige estar no registry: tool criada no
  // catálogo e vendida antes de alguém escrever o rótulo cai em `contratavel`,
  // e recusar aqui deixaria um switch na tela do cliente que sempre falha —
  // que era o comportamento anterior.
  if (!/^[a-z][a-z0-9_]{1,60}$/.test(toolNome)) {
    return { ok: false, erro: 'Módulo desconhecido.' };
  }

  // O guard de capacidade. Vem ANTES de qualquer ida ao banco: negar é mais
  // barato que consultar para depois negar.
  if (!clientePodeDesligar(toolNome)) {
    return {
      ok: false,
      erro: 'Este módulo é padrão do produto e não pode ser desligado.',
    };
  }

  const supabase = await criarClienteServidor();

  // Exige linha contratada. Sem esta checagem, uma chamada direta ligaria um
  // módulo que a agência não vendeu: o guard permite `ativo`, e o sub-workflow
  // do n8n consulta `tool_ativa` — não `contratado` — para decidir se responde.
  const { data: linha, error: erroSel } = await supabase
    .from('tenant_tools')
    .select('contratado')
    .eq('tenant_id', usuario.tenantId)
    .eq('tool_nome', toolNome)
    .maybeSingle();

  if (erroSel) return { ok: false, erro: `Não foi possível carregar: ${erroSel.message}` };
  if (!linha || !linha.contratado) {
    return { ok: false, erro: 'Este módulo não está incluído no seu plano. Fale com a agência.' };
  }

  const { error } = await supabase
    .from('tenant_tools')
    .update({ ativo })
    .eq('tenant_id', usuario.tenantId)
    .eq('tool_nome', toolNome);

  if (error) {
    if (error.code === '42501') {
      return { ok: false, erro: 'Sem permissão para alterar este módulo.' };
    }
    return { ok: false, erro: `Não foi possível salvar: ${error.message}` };
  }

  revalidatePath('/painel/configuracoes');
  return { ok: true };
}

/**
 * O tenant_admin edita as próprias configurações: mensagens de sistema,
 * debounce e liga/desliga do agente. NÃO o prompt (ação à parte, versionada),
 * nem modelo/temperatura/tokens (bloqueados pelo trigger).
 *
 * O tenantId vem de exigirTenantAdmin (JWT), nunca do formulário — regra 1 do
 * CLAUDE.md. Ainda que o formulário mandasse outro id, ele é ignorado.
 */
export async function salvarConfigTenant(
  _estado: EstadoConfig,
  fd: FormData,
): Promise<EstadoConfig> {
  const usuario = await exigirTenantAdmin();

  const validado = validarEdicaoTenantAdmin(fd);
  if (!validado.ok) return { errosCampo: validado.erros };

  const supabase = await criarClienteServidor();
  const { error } = await supabase
    .from('tenants')
    .update({
      agente_ativo: validado.valor.agente_ativo,
      debounce_segundos: validado.valor.debounce_segundos,
      msg_midia_nao_suportada: validado.valor.msg_midia_nao_suportada,
      msg_fora_escopo: validado.valor.msg_fora_escopo,
    })
    .eq('id', usuario.tenantId);

  if (error) {
    if (error.code === '42501') {
      return { erro: 'Sem permissão para alterar estes campos.' };
    }
    return { erro: `Não foi possível salvar: ${error.message}` };
  }

  revalidatePath('/painel');
  revalidatePath('/painel/configuracoes');
  return { sucesso: 'Configurações salvas.' };
}

/**
 * Cliente configura o COMPORTAMENTO da transferência para atendimento humano:
 * horário de atendimento e para onde ser avisado no WhatsApp.
 *
 * NÃO grava `ativo`: ligar/desligar é do switch em "Meus módulos"
 * (alternarModulo), fonte única. Enquanto os dois existiam, este formulário
 * enviava o `ativo` que fotografou ao montar (checkbox uncontrolled), então
 * salvar o horário depois de mexer no switch revertia o switch em silêncio.
 *
 * Infra (workflow_id, descrição, sessão do WAHA) é da agência e NÃO é tocada
 * aqui — só atualizamos `ativo` e `config`, e o `config` é reconstruído
 * preservando a `sessao` que a agência gravou. A linha precisa já existir
 * (a agência habilita a tool antes); senão, orientamos a falar com a agência.
 *
 * tenantId vem do JWT (exigirTenantAdmin) e filtramos explícito por ele (regra
 * 1 e 6). RLS de tenant_tools ainda escopa por tenant como rede de segurança.
 */
export async function salvarTransferirHumano(
  _estado: EstadoConfig,
  fd: FormData,
): Promise<EstadoConfig> {
  const usuario = await exigirTenantAdmin();

  const validado = validarTransferirCliente(fd);
  if (!validado.ok) return { errosCampo: validado.erros };

  const supabase = await criarClienteServidor();

  const { data: linha, error: erroSel } = await supabase
    .from('tenant_tools')
    .select('config')
    .eq('tenant_id', usuario.tenantId)
    .eq('tool_nome', TOOL_TRANSFERIR)
    .maybeSingle();

  if (erroSel) return { erro: `Não foi possível carregar: ${erroSel.message}` };
  if (!linha) {
    return {
      erro: 'A transferência para humano ainda não foi habilitada pela agência para este cliente.',
    };
  }

  const atual = (linha.config ?? {}) as Partial<ConfigTransferir>;
  const sessao = atual.notificacao?.sessao;

  // Sem sessão configurada pela agência, não há para onde o WAHA enviar — força
  // canal 'nenhum' para não deixar um 'waha' pendurado que falharia calado.
  const canal = validado.valor.canal === 'waha' && sessao ? 'waha' : 'nenhum';

  const novaConfig: ConfigTransferir = {
    horario: validado.valor.horario,
    notificacao: {
      canal,
      ...(sessao ? { sessao } : {}),
      ...(validado.valor.destino ? { destino: validado.valor.destino } : {}),
    },
  };

  const { error } = await supabase
    .from('tenant_tools')
    .update({ config: novaConfig })
    .eq('tenant_id', usuario.tenantId)
    .eq('tool_nome', TOOL_TRANSFERIR);

  if (error) return { erro: `Não foi possível salvar: ${error.message}` };

  revalidatePath('/painel/configuracoes');
  return { sucesso: 'Configuração de transferência salva.' };
}


/**
 * O que a verificação de time precisa, e o que FALTA quando não dá para rodar.
 *
 * POR QUE EXISTE UM CLIENTE ADMIN AQUI, num fluxo de tenant_admin: o token do
 * Chatwoot mora em `tenant_credenciais`, cuja ÚNICA policy é
 * `auth_is_super_admin()` — a migração 21a tirou a credencial do alcance do
 * cliente de propósito. Lendo com a sessão dele, `cred` volta sempre nula, e a
 * verificação nunca rodava para ninguém. Foi o que aconteceu no primeiro teste
 * real: os dois times ficaram "não verificado", inclusive o número certo.
 *
 * O `service_role` fica no servidor e o token não volta para o browser: ele é
 * usado aqui para chamar o Chatwoot e some. O filtro por `tenantId` vem do JWT
 * (`exigirTenantAdmin`), nunca do formulário.
 *
 * OS TRÊS MOTIVOS SÃO DISTINTOS DE PROPÓSITO. Cada um tem uma saída diferente:
 * sem conexão, alguém conecta a conta; sem credencial guardada, é a agência;
 * sem conversa encerrada, é encerrar uma conversa. Dizer "não está conectado"
 * quando o que falta é conversa manda procurar no lugar errado — e o cliente
 * confere a conexão, acha tudo certo, e não sai do lugar.
 */
async function contextoDeVerificacao(tenantId: string): Promise<
  | { ok: true; url: string; accountId: number | string; token: string; conversationId: number | string }
  | { ok: false; motivo: string }
> {
  const supabase = await criarClienteServidor();
  const admin = criarClienteAdmin();

  const { data: tenant } = await supabase
    .from('tenants')
    .select('chatwoot_url, chatwoot_account_id')
    .eq('id', tenantId)
    .maybeSingle();

  if (!tenant?.chatwoot_account_id || !tenant.chatwoot_url) {
    return {
      ok: false,
      motivo: 'este cliente ainda não está conectado a uma conta do Chatwoot',
    };
  }

  // service_role: a RLS de tenant_credenciais é super-admin-only (migração 21a).
  const { data: cred } = await admin
    .from('tenant_credenciais')
    .select('chatwoot_token')
    .eq('tenant_id', tenantId)
    .maybeSingle();

  if (!cred?.chatwoot_token) {
    return {
      ok: false,
      motivo:
        'a credencial do Chatwoot deste cliente não está guardada — quem resolve é a agência',
    };
  }

  /*
   * A conversa MENOS RECENTEMENTE TOCADA do tenant, qualquer status.
   *
   * Era `status = 'resolvido'` — e isso tornava o motivo 3 INALCANÇÁVEL.
   * Ninguém escreve `'resolvido'` em `public.conversas`: os dois pontos do n8n
   * que chamam `api_n8n_definir_status_conversa` passam `'pausado'` fixo, o
   * painel só alterna ativo/pausado, e não existe webhook de mudança de status
   * do Chatwoot. Produção tem 73 conversas — 72 `ativo`, 1 `pausado`, nenhuma
   * `resolvido` desde maio. O CHECK da coluna aceita o valor, o que dá
   * aparência de estado suportado; é estado morto.
   *
   * O efeito era o defeito que este arquivo já tinha consertado uma vez:
   * a tela mandava "encerre uma conversa no Chatwoot", o cliente encerrava,
   * nada mudava no banco, e ele voltava para a mesma frase.
   *
   * `atualizado_em` ascendente é a melhor aproximação disponível de "ninguém
   * está olhando esta agora". Não é garantia — é o menos pior sem espelhar o
   * status do Chatwoot (registrado em docs/PENDENCIAS.md).
   */
  const { data: conversa } = await supabase
    .from('conversas')
    .select('conversation_id')
    .eq('tenant_id', tenantId)
    .order('atualizado_em', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!conversa) {
    return {
      ok: false,
      motivo:
        'este cliente ainda não recebeu nenhuma conversa — a verificação precisa de uma que exista',
    };
  }

  return {
    ok: true,
    url: tenant.chatwoot_url,
    accountId: tenant.chatwoot_account_id,
    token: cred.chatwoot_token,
    conversationId: conversa.conversation_id,
  };
}

/**
 * Cadastra um time do Chatwoot para o tenant.
 *
 * O CADASTRO É MANUAL porque o token de Agent Bot não lista times — `GET /teams`
 * responde 401 "not authorized for bots" (medido em 18/08). Não há seletor a
 * popular; o cliente copia o número da URL do Chatwoot.
 *
 * E POR ISSO A VALIDAÇÃO EXISTE. `team_id` errado não dá erro na hora de
 * transferir: o Chatwoot devolve 200 com corpo `null` e a conversa não vai para
 * lugar nenhum. Descobrir isso na tela é incomparavelmente melhor que descobrir
 * num atendimento que não chegou.
 *
 * O que NÃO acontece aqui: bloquear o salvamento quando a verificação não roda.
 * Sem conversa nenhuma no tenant (cliente novo, que é exatamente quem está
 * cadastrando), não há onde testar — o time entra como NÃO VERIFICADO, com o
 * aviso. Estado declarado é melhor que validação que finge ter acontecido.
 */
export async function salvarTime(_estado: EstadoConfig, fd: FormData): Promise<EstadoConfig> {
  const usuario = await exigirTenantAdmin();

  const validado = validarTime(fd);
  if (!validado.ok) return { errosCampo: validado.erros };
  const { teamId, nome, descricao, padrao } = validado.valor;

  const supabase = await criarClienteServidor();

  // O teto da SOMA também é checado aqui, para a mensagem ser útil: o trigger
  // do banco barra de qualquer jeito (inclusive script e SQL avulso), mas o
  // erro dele não sabe quanto sobrou.
  const { data: existentes } = await supabase
    .from('tenant_times')
    .select('descricao')
    .eq('tenant_id', usuario.tenantId);
  const usados = (existentes ?? []).reduce((a, t) => a + (t.descricao?.length ?? 0), 0);
  if (usados + descricao.length > MAX_DESCRICAO_TOTAL) {
    return {
      errosCampo: {
        descricao:
          `As descrições somam ${usados} de ${MAX_DESCRICAO_TOTAL} caracteres e esta tem ` +
          `${descricao.length}. Encurte alguma — elas entram no prompt a cada mensagem.`,
      },
    };
  }

  /*
   * A VERIFICAÇÃO usa a conversa mais antiga já RESOLVIDA, e não a mais
   * recente: a recente é provavelmente um atendimento em curso, e atribuir e
   * desatribuir ali é mexer na tela de quem está trabalhando.
   */
  const ctx = await contextoDeVerificacao(usuario.tenantId);

  let verificadoEm: string | null = null;
  let aviso: string | null = null;

  if (!ctx.ok) {
    aviso = `Time salvo sem verificar: ${ctx.motivo}.`;
  } else {
    const r = await verificarTime({ ...ctx, teamId });
    if (r.estado === 'existe') verificadoEm = new Date().toISOString();
    else if (r.estado === 'nao_existe') {
      // NÃO SALVA. É o caso que a validação existe para pegar.
      return {
        errosCampo: {
          team_id:
            `O Chatwoot não tem o time ${teamId} nesta conta. Confira o número no fim da ` +
            'URL, em Configurações → Times → clicar no time.',
        },
      };
    } else {
      aviso = `Time salvo sem verificar: ${r.motivo}.`;
    }
  }

  const { error } = await supabase.from('tenant_times').insert({
    tenant_id: usuario.tenantId,
    team_id: teamId,
    nome,
    descricao,
    padrao,
    verificado_em: verificadoEm,
    // `falhou_em` NÃO entra no insert: o caminho `nao_existe` retorna antes de
    // salvar, então no cadastro ele seria sempre nulo. Quem o preenche é
    // `verificarTimeSalvo` (e, no futuro, o sub-workflow quando a atribuição
    // real devolver corpo nulo) — ou seja, ele marca time que EXISTIA e sumiu,
    // que é exatamente o caso que o selo vermelho da tela mostra.
  });

  if (error) {
    if (error.code === '23505') {
      return {
        erro:
          'Já existe um time com esse número ou esse nome — ou já há um time padrão. ' +
          'O agente escolhe pelo nome, então dois iguais o deixariam sem critério.',
      };
    }
    if (error.code === '23514') return { erro: error.message };
    return { erro: `Não foi possível salvar: ${error.message}` };
  }

  revalidatePath('/painel/configuracoes');
  return {
    sucesso: aviso ?? `Time “${nome}” salvo e confirmado no Chatwoot.`,
  };
}

/** Revalida um time já cadastrado — o botão ao lado do aviso de "não encontrado". */
export async function verificarTimeSalvo(_estado: EstadoConfig, fd: FormData): Promise<EstadoConfig> {
  const usuario = await exigirTenantAdmin();
  const id = String(fd.get('id') ?? '');
  if (!id) return { erro: 'Time não informado.' };

  const supabase = await criarClienteServidor();
  const { data: time } = await supabase
    .from('tenant_times')
    .select('team_id, nome')
    .eq('tenant_id', usuario.tenantId)
    .eq('id', id)
    .maybeSingle();
  if (!time) return { erro: 'Time não encontrado.' };

  // O MESMO motivo das duas telas. Antes, esta ação dizia "falta conexão com o
  // Chatwoot OU conversa encerrada" e a outra dizia "não está conectado": duas
  // mensagens discordando sobre a mesma causa, e a segunda apontando para o
  // lugar errado.
  const ctx = await contextoDeVerificacao(usuario.tenantId);
  if (!ctx.ok) return { erro: `Ainda não dá para verificar: ${ctx.motivo}.` };

  const r = await verificarTime({ ...ctx, teamId: time.team_id });

  const agora = new Date().toISOString();
  await supabase
    .from('tenant_times')
    .update(
      r.estado === 'existe'
        ? { verificado_em: agora, falhou_em: null }
        : r.estado === 'nao_existe'
          ? { falhou_em: agora }
          : {},
    )
    .eq('tenant_id', usuario.tenantId)
    .eq('id', id);

  revalidatePath('/painel/configuracoes');
  if (r.estado === 'existe') return { sucesso: `“${time.nome}” confirmado no Chatwoot.` };
  if (r.estado === 'nao_existe') {
    return { erro: `“${time.nome}” não existe mais no Chatwoot (time ${time.team_id}).` };
  }
  return { erro: `Não deu para verificar agora: ${r.motivo}.` };
}

/** Remove um time. O padrão só sai depois de outro assumir. */
export async function excluirTime(_estado: EstadoConfig, fd: FormData): Promise<EstadoConfig> {
  const usuario = await exigirTenantAdmin();
  const id = String(fd.get('id') ?? '');
  if (!id) return { erro: 'Time não informado.' };

  const supabase = await criarClienteServidor();

  // Apagar o padrão deixaria o fallback sem destino, e o modo de falha volta a
  // ser silencioso — que é o que este desenho inteiro existe para impedir.
  const { data: alvo } = await supabase
    .from('tenant_times')
    .select('padrao, nome')
    .eq('tenant_id', usuario.tenantId)
    .eq('id', id)
    .maybeSingle();
  if (!alvo) return { erro: 'Time não encontrado.' };

  if (alvo.padrao) {
    const { count } = await supabase
      .from('tenant_times')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', usuario.tenantId);
    if ((count ?? 0) > 1) {
      return {
        erro:
          `“${alvo.nome}” é o time padrão — para onde vai quando o agente não sabe escolher. ` +
          'Marque outro como padrão antes de removê-lo.',
      };
    }
  }

  const { error } = await supabase
    .from('tenant_times')
    .delete()
    .eq('tenant_id', usuario.tenantId)
    .eq('id', id);

  if (error) return { erro: `Não foi possível remover: ${error.message}` };
  revalidatePath('/painel/configuracoes');
  return { sucesso: `Time “${alvo.nome}” removido.` };
}
