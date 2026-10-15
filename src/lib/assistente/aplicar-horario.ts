import { datasParaExibir, type HorarioAgente } from '@/lib/tenants/horario-agente';

import type { Janela } from './proposta';

/**
 * O FORMULÁRIO de horário que a aprovação de uma proposta envia.
 *
 * Mora separado da Server Action para poder ser EXERCITADO: o teste monta este
 * FormData e passa pelo `validarHorarioAgente` de verdade, provando que o
 * horário que sai preserva o que a proposta não toca. Dentro da action isso só
 * poderia ser conferido lendo o código, que é o que deixou o defeito passar.
 *
 * O DEFEITO, medido em 15/10 no painel local: `salvarHorarioAgente` monta o
 * jsonb INTEIRO a partir do formulário, e o que não vem assume o padrão. A
 * primeira versão mandava só as janelas, então aprovar "configure meu horário"
 * gravava `fora_horario: 'aviso'` por cima da escolha do cliente e apagava as
 * datas de feriado e a mensagem dele. O cliente aprova uma coisa e perde outra,
 * cadastrada noutra tela, sem nada dizer.
 *
 * A regra, e vale para toda proposta futura: **o que a proposta não muda é
 * lido do que está gravado e devolvido igual.** Fuso e postura são decisão do
 * cliente; o modelo não escolhe nenhum dos dois.
 */
export function formularioDeHorario(janelas: Janela[], atual: HorarioAgente | null): FormData {
  const f = new FormData();
  f.set('horario_ativo', 'on');
  f.set('janelas', JSON.stringify(janelas));
  f.set('timezone', atual?.timezone ?? 'America/Sao_Paulo');
  f.set('fora_horario', atual?.fora_horario ?? 'aviso');
  // O banco guarda `YYYY-MM-DD` e o formulário lê `DD/MM/AAAA`: mandar as datas
  // cruas faz a validação recusar com "Data inválida", e o cliente vê a
  // proposta falhar sem entender por quê. `datasParaExibir` é a mesma função
  // que a tela de Configurações usa para preencher o campo.
  f.set('fechados', datasParaExibir(atual?.fechados));
  f.set('mensagem', atual?.mensagem ?? '');
  return f;
}
