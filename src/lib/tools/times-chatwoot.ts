/**
 * Times do Chatwoot: constantes e validação de formulário.
 *
 * SEM `server-only` de propósito: a tela do cliente importa os tetos para
 * mostrar os contadores, e o contador tem de bater com o que o servidor recusa.
 * Aqui não há segredo — a chamada que usa o token vive em
 * `times-chatwoot.server.ts`, essa sim server-only.
 */

/** Por descrição. Existe só para uma não comer a cota inteira. */
export const MAX_DESCRICAO = 120;

/**
 * O teto que segura o custo. As descrições entram no System Message A CADA
 * CHAMADA ao modelo: 720 caracteres ≈ 232 tokens por chamada, ≈ 465 num turno
 * de duas — cerca de 6% de um turno típico.
 *
 * É a SOMA que precisa de limite, e não cada linha: quinze times de 80
 * caracteres passam em qualquer validação individual e custam o dobro do
 * cenário de seis de 120.
 */
export const MAX_DESCRICAO_TOTAL = 720;

export const MAX_NOME = 40;

export type CampoErro = Record<string, string>;

export type TimeValidado = {
  teamId: number;
  nome: string;
  descricao: string;
  padrao: boolean;
};

/** Valida o formulário. Não fala com o Chatwoot — isso é `verificarTime`. */
export function validarTime(fd: FormData): { ok: true; valor: TimeValidado } | { ok: false; erros: CampoErro } {
  const erros: CampoErro = {};

  const bruto = String(fd.get('team_id') ?? '').trim();
  const teamId = Number(bruto);
  if (!bruto) erros['team_id'] = 'Informe o número do time.';
  else if (!Number.isInteger(teamId) || teamId < 1) {
    erros['team_id'] = 'O número do time é só dígitos — é o final da URL no Chatwoot.';
  }

  const nome = String(fd.get('nome') ?? '').trim();
  if (!nome) erros['nome'] = 'Informe o nome.';
  else if (nome.length > MAX_NOME) erros['nome'] = `Máximo de ${MAX_NOME} caracteres.`;

  const descricao = String(fd.get('descricao') ?? '').trim();
  if (descricao.length > MAX_DESCRICAO) {
    erros['descricao'] = `Máximo de ${MAX_DESCRICAO} caracteres (tem ${descricao.length}).`;
  }

  if (Object.keys(erros).length > 0) return { ok: false, erros };
  return { ok: true, valor: { teamId, nome, descricao, padrao: fd.get('padrao') === 'on' } };
}

/**
 * O time chega ao agente? É a MESMA regra que a migração 45 aplica em
 * `api_n8n_times` — `verificado_em is not null and falhou_em is null`.
 *
 * Existe como função, e não escrita à mão em cada lugar, porque as duas metades
 * já divergiram uma vez: o `semPadrao` da tela olhava só `padrao`, então um
 * padrão sem selo dava tela calada afirmando por omissão que estava tudo certo,
 * enquanto o n8n não receberia time nenhum. Quem mexer aqui tem que mexer na
 * migração junto — e o contrário também.
 *
 * Por que o selo é contrato e não enfeite: `POST /assignments` com `team_id`
 * inexistente responde 200 com corpo `null` e DESATRIBUI a conversa. Mandar id
 * não provado não é inofensivo.
 */
export function timeUtilizavel(t: {
  verificado_em: string | null;
  falhou_em: string | null;
}): boolean {
  return t.verificado_em !== null && t.falhou_em === null;
}
