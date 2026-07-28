/**
 * Validacao e normalizacao dos campos de tenant, num lugar so.
 *
 * Sem 'server-only': o formulario client importa MODELOS_PERMITIDOS daqui. Nao
 * ha segredo neste arquivo — so regras de validacao, que rodam de fato nas
 * Server Actions.
 *
 * O banco ja tem CHECKs (temperatura 0..2, debounce 1..60, slug/chatwoot UNIQUE)
 * e um trigger que barra o tenant_admin de tocar coluna protegida. Isto aqui e
 * a camada de mensagem amigavel antes de bater no banco — nao substitui as
 * garantias do Postgres, antecipa o erro com texto legivel.
 */

export const MODELOS_PERMITIDOS = [
  'gpt-4.1-mini',
  'gpt-4.1',
  'gpt-4o-mini',
  'gpt-4o',
  'gpt-5',
  'gpt-5-mini',
] as const;

export type Modelo = (typeof MODELOS_PERMITIDOS)[number];

export type ResultadoValidacao<T> =
  | { ok: true; valor: T }
  | { ok: false; erros: Record<string, string> };

/** slug: minusculas, numeros e hifen; nao comeca nem termina com hifen. */
export function normalizarSlug(bruto: string): string {
  return bruto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // remove acentos
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export type DadosCriacaoTenant = {
  nome: string;
  slug: string;
  system_prompt: string;
  modelo: Modelo;
  temperatura: number;
  debounce_segundos: number;
};

/**
 * Campos que o tenant_admin pode editar. Espelha exatamente a whitelist do
 * trigger tenants_guard_colunas — se divergir, o trigger recusa e a UI mente.
 */
export type DadosEdicaoTenantAdmin = {
  system_prompt: string;
  agente_ativo: boolean;
  debounce_segundos: number;
  msg_midia_nao_suportada: string;
  msg_fora_escopo: string;
};

function validarComuns(fd: FormData, erros: Record<string, string>) {
  const debounceBruto = String(fd.get('debounce_segundos') ?? '').trim();
  const debounce = Number(debounceBruto);
  if (!Number.isInteger(debounce) || debounce < 1 || debounce > 60) {
    erros['debounce_segundos'] = 'Debounce deve ser inteiro entre 1 e 60 segundos.';
  }
  return { debounce };
}

export function validarCriacaoTenant(
  fd: FormData,
): ResultadoValidacao<DadosCriacaoTenant> {
  const erros: Record<string, string> = {};

  const nome = String(fd.get('nome') ?? '').trim();
  if (nome.length < 2) erros['nome'] = 'Informe o nome do cliente.';

  const slugBruto = String(fd.get('slug') ?? '').trim();
  const slug = slugBruto ? normalizarSlug(slugBruto) : normalizarSlug(nome);
  if (slug.length < 2) erros['slug'] = 'Slug inválido. Use letras, números e hífen.';

  const system_prompt = String(fd.get('system_prompt') ?? '').trim();

  const modelo = String(fd.get('modelo') ?? '') as Modelo;
  if (!MODELOS_PERMITIDOS.includes(modelo)) erros['modelo'] = 'Modelo não reconhecido.';

  /*
   * temperatura chega como string do formulario. Number('') === 0, que seria um
   * valor valido silencioso — por isso a checagem de string vazia antes.
   */
  const tempBruta = String(fd.get('temperatura') ?? '').trim().replace(',', '.');
  const temperatura = tempBruta === '' ? NaN : Number(tempBruta);
  if (Number.isNaN(temperatura) || temperatura < 0 || temperatura > 2) {
    erros['temperatura'] = 'Temperatura deve estar entre 0 e 2.';
  }

  const { debounce } = validarComuns(fd, erros);

  if (Object.keys(erros).length > 0) return { ok: false, erros };

  return {
    ok: true,
    valor: { nome, slug, system_prompt, modelo, temperatura, debounce_segundos: debounce },
  };
}

export function validarEdicaoTenantAdmin(
  fd: FormData,
): ResultadoValidacao<DadosEdicaoTenantAdmin> {
  const erros: Record<string, string> = {};

  const system_prompt = String(fd.get('system_prompt') ?? '').trim();
  if (system_prompt.length < 1) erros['system_prompt'] = 'O prompt não pode ficar vazio.';

  const msg_midia = String(fd.get('msg_midia_nao_suportada') ?? '').trim();
  const msg_fora = String(fd.get('msg_fora_escopo') ?? '').trim();

  const agente_ativo = fd.get('agente_ativo') === 'on' || fd.get('agente_ativo') === 'true';

  const { debounce } = validarComuns(fd, erros);

  if (Object.keys(erros).length > 0) return { ok: false, erros };

  return {
    ok: true,
    valor: {
      system_prompt,
      agente_ativo,
      debounce_segundos: debounce,
      msg_midia_nao_suportada: msg_midia,
      msg_fora_escopo: msg_fora,
    },
  };
}
