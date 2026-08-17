'use server';

import { revalidatePath } from 'next/cache';

import { exigirSuperAdmin } from '@/lib/auth';
import { criarClienteServidor } from '@/lib/supabase/server';
import { MODELOS_PRECIFICAVEIS } from '@/lib/tenants/schema';

export type EstadoPreco = { erro?: string; sucesso?: string };

function numeroOuNull(v: FormDataEntryValue | null): number | null {
  const s = String(v ?? '').trim().replace(',', '.');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Adiciona uma nova vigência de preço para um modelo. Não edita linhas antigas
 * — cria uma linha nova (modelo, vigente_desde), preservando o histórico para
 * o cálculo retroativo. Só super_admin (layout + RLS de precos_modelo).
 */
export async function adicionarPreco(
  _estado: EstadoPreco,
  fd: FormData,
): Promise<EstadoPreco> {
  await exigirSuperAdmin();

  const modelo = String(fd.get('modelo') ?? '').trim();
  const vigenteDesde = String(fd.get('vigente_desde') ?? '').trim();
  if (!modelo) return { erro: 'Informe o modelo.' };
  if (!(MODELOS_PRECIFICAVEIS as readonly string[]).includes(modelo)) {
    return { erro: 'Modelo não reconhecido. Selecione um dos modelos suportados.' };
  }
  if (!vigenteDesde) return { erro: 'Informe a data de vigência.' };

  const entrada = numeroOuNull(fd.get('usd_entrada_por_1m'));
  const saida = numeroOuNull(fd.get('usd_saida_por_1m'));
  const embedding = numeroOuNull(fd.get('usd_embedding_por_1m'));

  if (entrada === null && saida === null && embedding === null) {
    return { erro: 'Preencha ao menos um preço (entrada, saída ou embedding).' };
  }

  const supabase = await criarClienteServidor();
  const { error } = await supabase.from('precos_modelo').insert({
    modelo,
    // Interpreta a data como início do dia UTC — vigência a partir daquela data.
    vigente_desde: `${vigenteDesde}T00:00:00+00`,
    usd_entrada_por_1m: entrada,
    usd_saida_por_1m: saida,
    usd_embedding_por_1m: embedding,
  });

  if (error) {
    if (error.code === '23505') {
      return { erro: 'Já existe preço para esse modelo nessa data de vigência.' };
    }
    return { erro: `Não foi possível salvar: ${error.message}` };
  }

  revalidatePath('/admin/consumo/precos');
  // O custo do histórico é recalculado com a tabela de preços a cada render.
  // Preço novo muda os números da tela do mês; sem isto ela ficaria no cache
  // mostrando o custo pela tabela antiga.
  revalidatePath('/admin/consumo');
  return { sucesso: `Preço de ${modelo} registrado a partir de ${vigenteDesde}.` };
}
