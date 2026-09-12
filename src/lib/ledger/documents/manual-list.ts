import type { PoolClient } from "pg";

import { LedgerError } from "../types";

/**
 * Listado paginado por keyset `(day, id)` ASC para las tres tablas de
 * documentos manuales. Filtros comunes: `from,to` (día), `status`,
 * `account_list_id` (cláusula propia por documento), `q` (ILIKE sobre las
 * columnas de texto del documento), `limit` (1..200, default 50) y `cursor`
 * = `"<day>,<id>"` de la última fila de la página anterior.
 */
export interface ListFilters {
  from?: string | null;
  to?: string | null;
  status?: string | null;
  account_list_id?: string | null;
  q?: string | null;
  limit?: number | null;
  cursor?: string | null;
}

export interface ListSpec {
  table: string;
  /** Columnas a devolver (ya con alias `d.`); `day` sale como `day::text`. */
  columns: string;
  /** SQL con `$N` = el account_list_id (usar `{{p}}` como placeholder). */
  accountClause: string;
  searchColumns: string[];
}

export interface ListPage<T> {
  items: T[];
  next_cursor: string | null;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseCursor(cursor: string): { day: string; id: string } {
  const [day, id] = cursor.split(",");
  if (!DAY_RE.test(day ?? "") || !id)
    throw new LedgerError("GL_SOURCE_INVALID", { reason: "invalid_cursor" });
  return { day: day as string, id };
}

export async function listDocuments<T extends { day: string; id: string }>(
  client: PoolClient,
  spec: ListSpec,
  filters: ListFilters
): Promise<ListPage<T>> {
  const where: string[] = ["d.deleted_at IS NULL"];
  const params: unknown[] = [];
  const p = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };

  if (filters.from) where.push(`d.day >= ${p(filters.from)}::date`);
  if (filters.to) where.push(`d.day <= ${p(filters.to)}::date`);
  if (filters.status) where.push(`d.status = ${p(filters.status)}`);
  if (filters.account_list_id)
    where.push(
      spec.accountClause.replaceAll("{{p}}", p(filters.account_list_id))
    );
  if (filters.q && filters.q.trim()) {
    const like = p(`%${filters.q.trim()}%`);
    where.push(
      `(${spec.searchColumns.map((c) => `${c} ILIKE ${like}`).join(" OR ")})`
    );
  }
  if (filters.cursor) {
    const cursor = parseCursor(filters.cursor);
    where.push(`(d.day, d.id) > (${p(cursor.day)}::date, ${p(cursor.id)})`);
  }

  const rawLimit = filters.limit ?? 50;
  const limit = Math.min(
    200,
    Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 50)
  );

  const { rows } = await client.query<T>(
    `SELECT ${spec.columns} FROM ${spec.table} d
     WHERE ${where.join(" AND ")}
     ORDER BY d.day ASC, d.id ASC
     LIMIT ${p(limit + 1)}`,
    params
  );
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  const next_cursor =
    rows.length > limit && last ? `${last.day},${last.id}` : null;
  return { items, next_cursor };
}
