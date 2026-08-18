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
