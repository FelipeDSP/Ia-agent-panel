/**
 * Config da tool "transferir_humano" (linha em tenant_tools).
 *
 * O `config` jsonb tem a forma que o workflow do n8n lê — não mude os nomes de
 * campo sem mexer no workflow junto:
 *
 *   { horario: { timezone, dias_semana[], hora_inicio, hora_fim },
 *     notificacao: { canal: 'waha'|'nenhum', sessao?, destino? } }
 *
 * Corte de responsabilidade (decisão de produto):
 *  - Cliente (painel): ativo, horario, notificacao.canal, notificacao.destino.
 *  - Agência (super_admin): workflow_id, descricao, notificacao.sessao.
 * Cada lado preserva os campos do outro ao salvar (merge do jsonb).
 *
 * Puro (sem server-only): as constantes e tipos são importados também pelos
 * componentes de formulário no browser.
 */

export const TOOL_TRANSFERIR = 'transferir_humano';

export type Horario = {
  timezone: string;
  dias_semana: number[];
  hora_inicio: number;
  hora_fim: number;
};

export type Notificacao = {
  canal: 'waha' | 'nenhum';
  sessao?: string;
  destino?: string;
};

export type ConfigTransferir = {
  horario: Horario;
  notificacao: Notificacao;
};

/** Fusos brasileiros — o cliente escolhe o dele para o horário bater. */
export const TIMEZONES_BR = [
  'America/Sao_Paulo',
  'America/Fortaleza',
  'America/Recife',
  'America/Bahia',
  'America/Belem',
  'America/Manaus',
  'America/Cuiaba',
  'America/Campo_Grande',
  'America/Porto_Velho',
  'America/Rio_Branco',
  'America/Boa_Vista',
  'America/Maceio',
] as const;

/** 0=Dom … 6=Sáb — mesma convenção do Date.getDay() que o n8n usa. */
export const DIAS_SEMANA: { valor: number; nome: string }[] = [
  { valor: 0, nome: 'Dom' },
  { valor: 1, nome: 'Seg' },
  { valor: 2, nome: 'Ter' },
  { valor: 3, nome: 'Qua' },
  { valor: 4, nome: 'Qui' },
  { valor: 5, nome: 'Sex' },
  { valor: 6, nome: 'Sáb' },
];

export const HORARIO_PADRAO: Horario = {
  timezone: 'America/Sao_Paulo',
  dias_semana: [1, 2, 3, 4, 5],
  hora_inicio: 8,
  hora_fim: 18,
};

/**
 * Número informado pelo cliente → chatId do WAHA (`<digitos>@c.us`).
 *
 * NÃO adivinha nada: não acrescenta código de país nem mexe no "nono dígito"
 * do WhatsApp brasileiro. O JID do WhatsApp não é derivável do número discável
 * — a mesma linha pode ter 9 no número mas não no JID (e vice-versa), sem regra
 * fixa. Então exige-se o número internacional completo (com país) OU o JID
 * colado, e o painel só garante o sufixo `@c.us`.
 *
 * Retorna null se não parecer válido — o chamador vira erro de campo.
 */
export function formatarDestino(bruto: string): string | null {
  const t = bruto.trim();
  if (!t) return null;

  // Já veio como JID (colado do WhatsApp/Chatwoot): usa como está.
  if (t.includes('@')) {
    return /^\d{10,15}@[a-z]+\.us$/i.test(t) ? t.toLowerCase() : null;
  }

  // Só dígitos: exige número internacional completo (com código do país). No
  // Brasil isso é 12–13 dígitos (55 + DDD + 8/9). Recusa 11 dígitos: seria um
  // número nacional sem o país (ex.: 69993666645), que vira um JID não roteável.
  const digitos = t.replace(/\D/g, '');
  if (digitos.length < 12 || digitos.length > 15) return null;
  return `${digitos}@c.us`;
}

/** JID guardado → dígitos, para preencher o input de novo. */
export function numeroParaExibir(destino: string | undefined | null): string {
  if (!destino) return '';
  return destino.replace(/@c\.us$/, '').replace(/\D/g, '');
}

type Resultado<T> = { ok: true; valor: T } | { ok: false; erros: Record<string, string> };

function inteiro(fd: FormData, campo: string): number | null {
  const bruto = String(fd.get(campo) ?? '').trim();
  if (bruto === '') return null;
  const n = Number(bruto);
  return Number.isInteger(n) ? n : null;
}

/**
 * Valida o que o CLIENTE edita no formulário de transferência. Não inclui
 * `sessao` (é da agência); o server mescla com o que já está gravado.
 *
 * Também não inclui `ativo`: ligar/desligar migrou para o switch de "Meus
 * módulos", que é o único escritor daquela coluna. Ver `alternarModulo`.
 */
export function validarTransferirCliente(fd: FormData): Resultado<{
  horario: Horario;
  canal: 'waha' | 'nenhum';
  destino?: string;
}> {
  const erros: Record<string, string> = {};

  const timezone = String(fd.get('timezone') ?? '').trim();
  if (!(TIMEZONES_BR as readonly string[]).includes(timezone)) {
    erros['timezone'] = 'Escolha um fuso horário válido.';
  }

  const dias_semana = DIAS_SEMANA.map((d) => d.valor).filter(
    (v) => fd.get(`dia_${v}`) === 'on',
  );
  if (dias_semana.length === 0) {
    erros['dias_semana'] = 'Selecione ao menos um dia.';
  }

  const hora_inicio = inteiro(fd, 'hora_inicio');
  const hora_fim = inteiro(fd, 'hora_fim');
  if (hora_inicio === null || hora_inicio < 0 || hora_inicio > 23) {
    erros['hora_inicio'] = 'Hora de início entre 0 e 23.';
  }
  if (hora_fim === null || hora_fim < 1 || hora_fim > 24) {
    erros['hora_fim'] = 'Hora de fim entre 1 e 24.';
  }
  if (
    hora_inicio !== null &&
    hora_fim !== null &&
    !erros['hora_inicio'] &&
    !erros['hora_fim'] &&
    hora_inicio >= hora_fim
  ) {
    erros['hora_fim'] = 'A hora de fim precisa ser maior que a de início.';
  }

  const notificar = fd.get('notificar') === 'on' || fd.get('notificar') === 'true';
  const destinoBruto = String(fd.get('destino') ?? '').trim();
  let destino: string | undefined;
  if (destinoBruto) {
    const jid = formatarDestino(destinoBruto);
    if (!jid) {
      erros['destino'] =
        'Informe o número com o código do país (ex.: 556993666645) ou cole o ID (…@c.us).';
    } else destino = jid;
  } else if (notificar) {
    erros['destino'] = 'Para avisar no WhatsApp, informe o número.';
  }

  if (Object.keys(erros).length > 0) return { ok: false, erros };

  return {
    ok: true,
    valor: {
      horario: {
        timezone,
        dias_semana,
        hora_inicio: hora_inicio as number,
        hora_fim: hora_fim as number,
      },
      canal: notificar ? 'waha' : 'nenhum',
      destino,
    },
  };
}

/**
 * Valida o que a AGÊNCIA edita (infra): descrição da tool e sessão WAHA.
 *
 * `workflow_id` não entra: no agente atual as tools são fixas nos nós, essa
 * coluna não liga nada. O que habilita a tool é a linha existir com ativo=true.
 */
export function validarTransferirAgencia(fd: FormData): Resultado<{
  sessao: string;
  descricao: string;
}> {
  const erros: Record<string, string> = {};

  const sessao = String(fd.get('sessao') ?? '').trim();
  const descricao = String(fd.get('descricao') ?? '').trim();
  if (!descricao) erros['descricao'] = 'Descreva quando o agente deve transferir.';

  if (Object.keys(erros).length > 0) return { ok: false, erros };

  return { ok: true, valor: { sessao, descricao } };
}
