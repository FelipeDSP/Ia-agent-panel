/**
 * Operacoes de usuario pela Admin API, com as duas defesas que este projeto
 * precisou aprender na marra.
 *
 * ---------------------------------------------------------------------------
 * 1. A Admin API falha de forma intermitente
 * ---------------------------------------------------------------------------
 *
 * Com a chave nova (sb_secret_...), cerca de 1 em 20 chamadas volta com:
 *
 *   invalid JWT: unable to parse or verify signature, token is unverifiable:
 *   error while executing keyfunc: unrecognized JWT kid <nil> for algorithm ES256
 *
 * Medido: 20 chamadas identicas de listUsers -> 19 ok, 1 falha. A mesma chave
 * que acabou de criar um usuario falha ao remove-lo e volta a funcionar em
 * seguida. E do lado do Supabase, na verificacao da chave nos endpoints de
 * auth — nao ha nada a corrigir na credencial.
 *
 * Sem retentativa, qualquer script que faca varias chamadas seguidas falha de
 * vez em quando por motivo nenhum, e a mensagem aponta para credencial errada.
 *
 * ---------------------------------------------------------------------------
 * 2. listUsers e eventualmente consistente
 * ---------------------------------------------------------------------------
 *
 * Usuario recem-criado nao aparece na listagem por alguns segundos: existe um
 * index worker alimentando a busca. Observado: createUser devolveu sucesso, o
 * SELECT em auth.users mostrou a linha, e listUsers no instante seguinte
 * devolveu zero, sem erro.
 *
 * Decorrencias:
 *   - guarde o id devolvido por createUser e remova por id
 *   - procurar por email exige repeticao com espera
 *   - para saber se um email ja existe, tente criar: o conflito e imediato,
 *     a listagem nao e
 */

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

const TRANSITORIO = /unrecognized JWT kid|invalid JWT|token is unverifiable/i;

/**
 * Repete enquanto o erro for a falha intermitente de verificacao da chave.
 * Qualquer outro erro volta na hora — retentar "email ja existe" so atrasaria.
 */
async function comRetentativa(operacao, { tentativas = 4, intervaloMs = 700 } = {}) {
  let ultimo = null;

  for (let i = 0; i < tentativas; i++) {
    const resultado = await operacao();

    if (!resultado?.error) return resultado;

    ultimo = resultado.error;
    if (!TRANSITORIO.test(ultimo.message ?? '')) return resultado;

    await espera(intervaloMs * (i + 1));
  }

  return { data: null, error: ultimo };
}

export function listarUsuarios(admin, params = { perPage: 1000 }) {
  return comRetentativa(() => admin.auth.admin.listUsers(params));
}

export function criarUsuario(admin, params) {
  return comRetentativa(() => admin.auth.admin.createUser(params));
}

export function atualizarUsuario(admin, id, params) {
  return comRetentativa(() => admin.auth.admin.updateUserById(id, params));
}

export function removerUsuario(admin, id) {
  return comRetentativa(() => admin.auth.admin.deleteUser(id));
}

/** Procura por email, insistindo enquanto a listagem nao converge. */
export async function acharPorEmail(admin, email, { tentativas = 1, intervaloMs = 1500 } = {}) {
  const alvo = email.toLowerCase();

  for (let i = 0; i < tentativas; i++) {
    const { data, error } = await listarUsuarios(admin);
    if (error) throw new Error(`listUsers falhou: ${error.message}`);

    const achado = data.users.find((u) => u.email?.toLowerCase() === alvo);
    if (achado) return achado;

    if (i < tentativas - 1) await espera(intervaloMs);
  }

  return null;
}

/** Remove por email. `tentativas` > 1 apenas se o usuario pode ser recente. */
export async function removerPorEmail(admin, email, opcoes = {}) {
  const usuario = await acharPorEmail(admin, email, opcoes);
  if (!usuario) return false;

  const { error } = await removerUsuario(admin, usuario.id);
  if (error) throw new Error(`deleteUser falhou para ${email}: ${error.message}`);
  return true;
}

/** Remove por id. Caminho preferido: nao depende da listagem. */
export async function removerPorId(admin, id) {
  const { error } = await removerUsuario(admin, id);
  if (error && !/not found/i.test(error.message)) {
    throw new Error(`deleteUser falhou para ${id}: ${error.message}`);
  }
}

/** GoTrue sinaliza email duplicado de mais de uma forma conforme a versao. */
export function ehEmailDuplicado(error) {
  if (!error) return false;
  return (
    error.code === 'email_exists' ||
    error.status === 422 ||
    /already (been )?registered|already exists/i.test(error.message ?? '')
  );
}
