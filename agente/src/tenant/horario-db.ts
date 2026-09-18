/** `tenants.horario_agente` (74) lido pelo serviço — null sem a migração ou sem configuração = sempre aberto. */
import { fnValor, type Db } from '../db.ts';
import { lerHorarioAgente, type HorarioAgente } from './horario.ts';

export async function lerHorarioDoAgente(db: Db, tenantId: string): Promise<HorarioAgente | null> {
  try { return lerHorarioAgente(await fnValor<unknown>(db, 'api_agente_horario', [tenantId])); }
  catch { return null; }
}
