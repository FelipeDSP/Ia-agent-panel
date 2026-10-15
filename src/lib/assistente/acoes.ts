'use server';

import { exigirTenantAdmin } from '@/lib/auth';
import { criarClienteServidor } from '@/lib/supabase/server';
import { lerHorarioAgente } from '@/lib/tenants/horario-agente';
import { salvarHorarioAgente } from '@/app/(app)/painel/acoes';
import { criarCategoria } from '@/app/(app)/painel/catalogo/acoes-categoria';
import { salvarProduto } from '@/app/(app)/painel/catalogo/acoes';
import { ingerirTexto } from '@/app/(app)/painel/conhecimento/acoes';
import { salvarPrompt } from '@/lib/tenants/prompt-acoes';

import { formularioDeHorario } from './aplicar-horario';
import { conversar, type Resultado } from './conversar';
import { detectar, ordenar, type Achado } from './deteccoes';
import { montarRetrato } from './snapshot';
import { modeloDoAmbiente } from './modelo';
import { hashPrompt } from './hash';
import { lerPropostas, TIPOS } from './proposta';

/**
 * As duas entradas do assistente, e a assimetria entre elas é o desenho.
 *
 *   `perguntar`  — conversa. Só leitura, custa token da agência, não muda nada.
 *   `aplicar`    — escreve, e por isso não confia em NADA do que recebe.
 *
 * SERVER ACTION É ENTRADA PRÓPRIA (CLAUDE.md, superfície de tool): ela não
 * passa por página nenhuma, então toda checagem mora aqui, não na tela. O que
 * chega pelo navegador — inclusive a proposta que o próprio assistente gerou
 * minutos antes — é dado de entrada e é revalidado do zero.
 *
 * O assistente NÃO é superfície de tool: ele é de toda conta, e o custo é da
 * agência. Então não há checagem de contratação aqui; o que ele PROPÕE, sim,
 * desemboca em ações que já têm as próprias checagens.
 */

export type EstadoAssistente =
  | { fase: 'vazio' }
  | { fase: 'ok'; resultado: Resultado }
  | { fase: 'erro'; erro: string };

export type Abertura = {
  achados: Achado[];
  /** O prompt atual, para a tela conseguir mostrar a diferença de uma proposta. */
  promptAtual: string;
  errosDeLeitura: string[];
};

/**
 * O que a bolha precisa saber quando ABRE — e só quando abre.
 *
 * A bolha vive em todas as telas do painel, então carregar o retrato junto com
 * cada página custaria seis consultas em toda navegação, para um painel que a
 * pessoa talvez nunca abra. Aqui ele é lido sob demanda, uma vez por abertura.
 *
 * Os achados são MECÂNICOS: nenhuma chamada a modelo acontece nesta ação. Abrir
 * a bolha não custa um centavo; só perguntar custa.
 */
export async function abrir(): Promise<Abertura> {
  const usuario = await exigirTenantAdmin();
  const supabase = await criarClienteServidor();
  const retrato = await montarRetrato(supabase, usuario.tenantId);
  return {
    achados: ordenar(detectar(retrato)),
    promptAtual: retrato.prompt,
    errosDeLeitura: retrato.erros,
  };
}

/**
 * Uma pergunta ao assistente.
 *
 * `nao_configurado` em vez de 500: painel sem `OPENAI_API_KEY` no ambiente é
 * estado previsto (é o caso do Coolify hoje), e a tela precisa poder dizer isso
 * em vez de mostrar erro genérico. Mesmo desenho do 503 do `/testar`.
 */
export async function perguntar(
  _estado: EstadoAssistente,
  fd: FormData,
): Promise<EstadoAssistente> {
  const usuario = await exigirTenantAdmin();
  const pergunta = String(fd.get('pergunta') ?? '').trim();
  if (!pergunta) return { fase: 'erro', erro: 'Escreva sua pergunta.' };

  const modelo = modeloDoAmbiente();
  if (!modelo) return { fase: 'erro', erro: 'O assistente ainda não está configurado neste ambiente.' };

  // O histórico volta do navegador. É a conversa do próprio cliente, então não
  // é dado hostil — mas é dado, e `conversar` o corta por tamanho e por
  // quantidade porque conversa longa é custo em todo turno.
  let historico: { papel: 'user' | 'assistant'; texto: string }[] = [];
  const cru = String(fd.get('historico') ?? '');
  if (cru) {
    try {
      const l = JSON.parse(cru) as unknown;
      if (Array.isArray(l)) {
        historico = l.flatMap((m) => {
          const o = (m && typeof m === 'object' ? m : {}) as Record<string, unknown>;
          const texto = String(o['texto'] ?? '');
          if (!texto) return [];
          return [{ papel: o['papel'] === 'assistant' ? 'assistant' as const : 'user' as const, texto }];
        });
      }
    } catch { historico = []; }
  }

  const supabase = await criarClienteServidor();
  try {
    const resultado = await conversar({ supabase, modelo }, { tenantId: usuario.tenantId, pergunta, historico });
    return { fase: 'ok', resultado };
  } catch (e) {
    // A mensagem da OpenAI (cota, modelo inexistente) é útil para a agência e
    // inócua para o cliente; o que não pode é a tela ficar muda.
    return { fase: 'erro', erro: `Não consegui responder agora: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export type EstadoAplicacao = { erro?: string; sucesso?: string };

/**
 * Aplica UMA proposta que o cliente aprovou.
 *
 * As quatro guardas, e cada uma existe por um modo de falha concreto:
 *
 *  1. `exigirTenantAdmin()` — o tenant sai do JWT. A proposta não tem campo de
 *     tenant (ver `proposta.ts`), então não há o que conferir: não há como
 *     apontar para outra conta;
 *  2. REVALIDAÇÃO INTEGRAL por `lerPropostas`, a mesma função que leu a saída
 *     do modelo. O que chega aqui é um JSON do navegador: pode ter sido editado,
 *     pode ser de outra sessão, pode nunca ter saído de modelo nenhum. Um tipo
 *     fora do conjunto fechado morre aqui;
 *  3. `baseHash` — o prompt mudou desde a proposta? Recusa. Sem isto, aprovar
 *     uma proposta de dez minutos atrás apaga calado a edição que o cliente fez
 *     na outra aba, e o trigger de versionamento guardaria a versão perdida num
 *     lugar que ninguém olha;
 *  4. a escrita vai pela MESMA Server Action da tela (`salvarPrompt`,
 *     `salvarHorarioAgente`). Nenhum `update` novo aqui: as validações, o guard
 *     de coluna e o versionamento do prompt são os que já existem e já são
 *     testados. Aprovar uma proposta é igual a digitar aquilo na tela.
 */
export async function aplicar(
  _estado: EstadoAplicacao,
  fd: FormData,
): Promise<EstadoAplicacao> {
  const usuario = await exigirTenantAdmin();

  let bruto: unknown = null;
  try { bruto = JSON.parse(String(fd.get('proposta') ?? '')); } catch { bruto = null; }
  const lista = Array.isArray(bruto) ? bruto : [bruto];
  const supabase = await criarClienteServidor();

  // O prompt atual é lido ANTES de validar, porque ele entra na validação: é
  // com ele que a guarda do marcador compara. Ler depois faria a revalidação
  // aqui ser mais fraca que a da leitura do modelo, e o navegador fica no meio
  // das duas.
  const { data: dTenant, error: eTenant } = await supabase.from('tenants')
    .select('system_prompt, horario_agente').eq('id', usuario.tenantId).maybeSingle();
  if (eTenant) return { erro: `Não consegui ler a configuração atual: ${eTenant.message}` };
  const linha = dTenant as { system_prompt: string | null; horario_agente: unknown } | null;
  const promptAtual = linha?.system_prompt ?? '';

  const { propostas, descartadas } = lerPropostas(lista, { promptAtual });
  const proposta = propostas[0];
  if (!proposta) {
    return { erro: descartadas[0] ? `Não sei aplicar isso: ${descartadas[0].motivo}.` : 'Proposta inválida.' };
  }

  if (proposta.tipo === 'prompt') {
    const atual = promptAtual;
    if (hashPrompt(atual) !== proposta.baseHash) {
      return { erro: 'O prompt mudou desde esta sugestão. Peça ao assistente de novo para ele olhar o texto atual.' };
    }
    const f = new FormData();
    f.set('system_prompt', proposta.texto);
    const r = await salvarPrompt(usuario.tenantId, {}, f);
    return r.erro ? { erro: r.erro } : { sucesso: `${TIPOS.prompt.rotulo}: feito.` };
  }

  if (proposta.tipo === 'categoria') {
    const f = new FormData();
    f.set('nome', proposta.nome);
    const r = await criarCategoria({}, f);
    return r.erro ? { erro: r.erro } : { sucesso: `Categoria "${proposta.nome}" criada.` };
  }

  if (proposta.tipo === 'conhecimento') {
    const f = new FormData();
    f.set('titulo', proposta.nomeDoDocumento);
    f.set('texto', proposta.texto);
    // `ingerirTexto` é SÍNCRONA: ela espera a Edge Function fatiar o texto e
    // gravar os embeddings, e só devolve sucesso com o job concluído. Por isso
    // o botão demora alguns segundos aqui, e por isso o texto tem teto.
    const r = await ingerirTexto({}, f);
    return r.erro ? { erro: r.erro } : { sucesso: r.sucesso ?? 'Conteúdo adicionado à base.' };
  }

  if (proposta.tipo === 'produto') {
    /*
     * O modelo não manipula UUID: ele diz NOMES, e o código resolve. Mesma
     * razão do dia da semana por nome — identificador é trabalho de código.
     *
     * Duas resoluções, e cada uma recusa com motivo em vez de improvisar:
     *
     *  - CATEGORIA inexistente não vira categoria nova por conta própria. Criar
     *    categoria é outra proposta, que o cliente aprova à parte: senão
     *    aprovar "cadastre o pão" encheria o catálogo de categorias que ele não
     *    pediu, e categoria é o que o agente FALA ao cliente dele;
     *  - ALVO (o produto a alterar) que não existe mais vira recusa, nunca um
     *    cadastro novo. Criar por engano um "Pão francês" duplicado é
     *    exatamente o defeito que o assistente aponta nas contas dos outros.
     */
    const [{ data: cats, error: eCat }, { data: prods, error: eProd }] = await Promise.all([
      supabase.from('categorias').select('id, nome').eq('tenant_id', usuario.tenantId),
      supabase.from('produtos').select('id, nome').eq('tenant_id', usuario.tenantId).is('deletado_em', null),
    ]);
    if (eCat || eProd) return { erro: `Não consegui ler seu catálogo: ${(eCat ?? eProd)?.message}` };

    const mesmoNome = (a: string, b: string) => a.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      === b.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

    const cat = ((cats ?? []) as { id: string; nome: string }[]).find((c) => mesmoNome(c.nome, proposta.categoria));
    if (!cat) {
      return {
        erro: `Você ainda não tem a categoria "${proposta.categoria}". Peça ao assistente para criá-la primeiro, ou crie em Catálogo → Categorias.`,
      };
    }

    const f = new FormData();
    if (proposta.alvo) {
      const alvo = ((prods ?? []) as { id: string; nome: string }[]).find((p) => mesmoNome(p.nome, proposta.alvo!));
      if (!alvo) return { erro: `Não achei o produto "${proposta.alvo}" no seu catálogo. Ele pode ter sido renomeado ou removido.` };
      f.set('id', alvo.id);
    }
    f.set('nome', proposta.nome);
    f.set('preco', proposta.preco);
    f.set('unidade', proposta.unidade);
    f.set('categoria_id', cat.id);
    f.set('descricao', proposta.descricao ?? '');
    if (proposta.disponivel) f.set('disponivel', 'on');
    // `estoque` vazio = não controla estoque, que é o padrão da tela. O SKU é
    // do banco (trigger) e não vai no formulário, nem na criação nem na edição.
    f.set('estoque', '');

    const r = await salvarProduto({}, f);
    if (r.erro) return { erro: r.erro };
    if (r.errosCampo) return { erro: Object.values(r.errosCampo)[0] ?? 'Produto inválido.' };
    return { sucesso: proposta.alvo ? `"${proposta.nome}" atualizado no catálogo.` : `"${proposta.nome}" cadastrado no catálogo.` };
  }

  /*
   * Horário: a proposta muda as FAIXAS e MAIS NADA.
   *
   * `salvarHorarioAgente` recebe o horário INTEIRO num FormData e monta o jsonb
   * do zero: fuso, postura fora do horário, datas fechadas e mensagem saem
   * todos dos campos do formulário, e o que não vem assume o padrão. Mandar só
   * as janelas, como a primeira versão fazia, não era "mudar as janelas" — era
   * reescrever o horário todo com o resto em branco.
   *
   * Medido em 15/10, no painel local: aprovar uma proposta de horário gravou
   * `fora_horario: 'aviso'` numa conta que não tinha horário — e teria apagado
   * as datas de feriado e a mensagem de uma conta que tivesse. O cliente aprova
   * "configurar o horário" e perde o que cadastrou em outra tela, sem aviso.
   *
   * Então tudo o que a proposta não toca é lido do que está gravado e
   * devolvido igual. Decisão do cliente continua do cliente: o modelo não
   * escolhe fuso (errá-lo move o expediente inteiro) nem postura.
   */
  const atual = lerHorarioAgente(linha?.horario_agente ?? null);

  const f = formularioDeHorario(proposta.janelas, atual);
  const r = await salvarHorarioAgente({}, f);
  if (r.erro) return { erro: r.erro };
  if (r.errosCampo) return { erro: Object.values(r.errosCampo)[0] ?? 'Horário inválido.' };
  // Conta que não tinha horário ganha a postura padrão, e isso muda o que o
  // cliente dela ouve fora do expediente. Dizer é mais barato que ele
  // descobrir pela reclamação de um cliente.
  return {
    sucesso: atual
      ? `${TIPOS.horario.rotulo}: feito.`
      : `${TIPOS.horario.rotulo}: feito. Fora do horário o agente avisa que está fechado — você muda isso em Configurações → Horário.`,
  };
}

