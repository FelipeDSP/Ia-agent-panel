/**
 * Acesso ao banco: um `Db` é só "rode esta query". Em produção é o Pool com o
 * role `n8n_agent`; no teste é o client de UMA transação abortada — por isso
 * todo módulo recebe `db`, nunca importa o pool.
 *
 * A única porta continua sendo função (`api_n8n_*`, `api_agente_*`): o role
 * não tem grant de tabela, então qualquer `select` direto aqui falharia — e é
 * assim que se quer.
 */
import pg from 'pg';

export interface Db {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, params?: unknown[]): Promise<pg.QueryResult<R>>;
}

export function criarPool(url: string): pg.Pool & Db {
  return new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 8 });
}

/** `select * from public.<fn>($1, $2, ...)` — uma linha. */
export async function fnUma<R extends pg.QueryResultRow>(db: Db, fn: string, args: unknown[]): Promise<R | undefined> {
  const marcadores = args.map((_, i) => `$${i + 1}`).join(', ');
  const r = await db.query<R>(`select * from public.${fn}(${marcadores})`, args);
  return r.rows[0];
}

/** `select * from public.<fn>(...)` — todas as linhas. */
export async function fnTodas<R extends pg.QueryResultRow>(db: Db, fn: string, args: unknown[]): Promise<R[]> {
  const marcadores = args.map((_, i) => `$${i + 1}`).join(', ');
  const r = await db.query<R>(`select * from public.${fn}(${marcadores})`, args);
  return r.rows;
}

/** `select public.<fn>(...) as v` — um escalar. */
export async function fnValor<T>(db: Db, fn: string, args: unknown[]): Promise<T> {
  const marcadores = args.map((_, i) => `$${i + 1}`).join(', ');
  const r = await db.query<{ v: T }>(`select public.${fn}(${marcadores}) as v`, args);
  return r.rows[0]?.v as T;
}
