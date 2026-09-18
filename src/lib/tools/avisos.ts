/**
 * "Avisos para você" (18/09) — UM lugar para o dono dizer para qual WhatsApp
 * quer ser avisado e de quê. Até aqui o número era pedido duas vezes na mesma
 * tela (transferência e vendas), com dois formulários e dois "fuso horário".
 *
 * Não há tabela nova: o formulário escreve nas duas configs que já existem
 * (`transferir_humano.config.notificacao` e `vendas.config.{eventos,
 * notificacao}`), preservando `sessao` (da agência) e o resto de cada uma. O
 * serviço e o n8n congelado continuam lendo o que sempre leram.
 *
 * Puro: importado pelo formulário.
 */
import { canalDerivado, EVENTOS, lerConfigVendas, type ConfigVendas, type Evento } from './vendas-config';
import { formatarDestino, numeroParaExibir, type ConfigTransferir } from './transferir-humano';

export type Avisos = {
  /** aviso por WhatsApp ligado (qualquer um dos dois) */
  whatsapp: boolean;
  /** dígitos para exibir */
  numero: string;
  /** avisar quando alguém pedir atendimento humano */
  transferencia: boolean;
  /** eventos de venda que avisam (só com vendas contratada) */
  eventos: Evento[];
  nota_chatwoot: boolean;
};

/** O estado atual a partir das duas configs. O número é o de vendas, senão o da transferência. */
export function lerAvisos(transferir: Partial<ConfigTransferir> | null, vendas: unknown | null, vendasContratada: boolean): Avisos {
  const v = vendas === null ? null : lerConfigVendas(vendas);
  const nt = transferir?.notificacao;
  const destino = v?.notificacao.destino ?? nt?.destino;
  return {
    whatsapp: (nt?.canal ?? 'nenhum') !== 'nenhum' || (v?.notificacao.canal ?? 'nenhum') !== 'nenhum',
    numero: numeroParaExibir(destino),
    transferencia: (nt?.canal ?? 'nenhum') !== 'nenhum',
    eventos: vendasContratada ? (v?.eventos ?? EVENTOS.map((e) => e.valor)) : [],
    nota_chatwoot: v?.notificacao.nota_chatwoot === true,
  };
}

type Resultado<T> = { ok: true; valor: T } | { ok: false; erros: Record<string, string> };

export function validarAvisos(fd: FormData, { vendasContratada }: { vendasContratada: boolean }): Resultado<{
  whatsapp: boolean; destino?: string; transferencia: boolean; eventos: Evento[]; nota_chatwoot: boolean;
}> {
  const erros: Record<string, string> = {};
  const whatsapp = fd.get('whatsapp') === 'on' || fd.get('whatsapp') === 'true';
  const transferencia = fd.get('aviso_transferencia') === 'on';
  const eventos = vendasContratada ? EVENTOS.map((e) => e.valor).filter((v) => fd.get(`evento_${v}`) === 'on') : [];
  const nota_chatwoot = vendasContratada && fd.get('nota_chatwoot') === 'on';

  const bruto = String(fd.get('destino') ?? '').trim();
  let destino: string | undefined;
  if (bruto) {
    const jid = formatarDestino(bruto);
    if (!jid) erros['destino'] = 'Informe o número com o código do país (ex.: 556993666645) ou cole o ID (…@c.us).';
    else destino = jid;
  } else if (whatsapp) {
    erros['destino'] = 'Para avisar no WhatsApp, informe o número.';
  }
  if (whatsapp && !transferencia && eventos.length === 0) {
    erros['whatsapp'] = 'Marque ao menos um aviso, ou desligue o WhatsApp.';
  }
  if (Object.keys(erros).length > 0) return { ok: false, erros };
  return { ok: true, valor: { whatsapp, destino, transferencia, eventos, nota_chatwoot } };
}

/** As duas configs prontas para gravar, a partir do que já está no banco. */
export function aplicarAvisos(
  v: { whatsapp: boolean; destino?: string; transferencia: boolean; eventos: Evento[]; nota_chatwoot: boolean },
  transferirAtual: Partial<ConfigTransferir> | null,
  vendasBruto: unknown | null,
): { transferir: ConfigTransferir | null; vendas: Record<string, unknown> | null } {
  let transferir: ConfigTransferir | null = null;
  if (transferirAtual) {
    const sessao = transferirAtual.notificacao?.sessao;
    transferir = {
      ...(transferirAtual as ConfigTransferir),
      notificacao: {
        canal: canalDerivado(v.whatsapp && v.transferencia, sessao),
        ...(sessao ? { sessao } : {}),
        ...(v.destino ? { destino: v.destino } : {}),
      },
    };
  }
  let vendas: Record<string, unknown> | null = null;
  if (vendasBruto !== null) {
    const atual = lerConfigVendas(vendasBruto);
    const bruto = (vendasBruto && typeof vendasBruto === 'object' ? vendasBruto : {}) as Record<string, unknown>;
    const sessao = atual.notificacao.sessao;
    const nova: Pick<ConfigVendas, 'eventos' | 'notificacao'> = {
      // vazio no banco = todos; a tela distingue "nenhum" desligando o WhatsApp e a nota
      eventos: v.eventos.length > 0 ? v.eventos : EVENTOS.map((e) => e.valor),
      notificacao: {
        canal: canalDerivado(v.whatsapp && v.eventos.length > 0, sessao),
        ...(sessao ? { sessao } : {}),
        ...(v.destino ? { destino: v.destino } : {}),
        ...(v.nota_chatwoot ? { nota_chatwoot: true } : {}),
      },
    };
    vendas = { ...bruto, ...nova };
  }
  return { transferir, vendas };
}
