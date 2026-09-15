/**
 * `SqlClient` (knex-style `?` placeholders, the shape `month-close-data.ts` is written
 * for) on top of a pg `PoolClient` (`$n` placeholders).
 *
 * This is a DELIBERATE bridge across the "knex uses `?`, pg uses `$1`, never mix"
 * rule: the statement reopen chain has to reopen a Month Close INSIDE the banking pg
 * transaction so the whole chain commits or rolls back together. The rewrite is
 * knex's own `Client_PG.positionBindings` (an escaped `\?` stays a literal `?` and is
 * not counted — that is how knex spells the JSONB `?` operator), so every query
 * authored for knex binds identically here. Use it only to feed knex-authored
 * queries from a pg transaction; do not author new SQL against it (2026-09-15).
 */
import type { PoolClient } from "pg";

import type { SqlClient } from "./month-close-data";

export function positionBindings(sql: string): string {
  let questionCount = 0;
  return sql.replace(/(\\*)(\?)/g, (_match, escapes: string) => {
    if (escapes.length % 2) return "?";
    questionCount += 1;
    return `$${questionCount}`;
  });
}

export function pgSqlClient(client: Pick<PoolClient, "query">): SqlClient {
  return {
    raw: async (sql, bindings = []) => {
      const result = await client.query(positionBindings(sql), bindings);
      return {
        rows: result.rows as Array<Record<string, unknown>>,
        rowCount: result.rowCount ?? undefined,
      };
    },
  };
}
