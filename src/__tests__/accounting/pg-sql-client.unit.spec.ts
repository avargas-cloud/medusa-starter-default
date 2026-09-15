import { pgSqlClient, positionBindings } from "../../lib/accounting/pg-sql-client";

/**
 * `month-close-data.ts` is written for knex (`?` placeholders). The reopen chain runs
 * it INSIDE the banking pg transaction (`$n` placeholders), so the adapter has to be
 * knex's own `positionBindings` — including the `\?` escape knex uses for a literal
 * question mark (JSONB `?` operator). Anything else silently mis-binds (2026-09-15).
 */
describe("positionBindings", () => {
  it("numbers every ? in order", () => {
    expect(positionBindings("SELECT ? , ?::date WHERE a = ?")).toBe(
      "SELECT $1 , $2::date WHERE a = $3"
    );
  });
  it("keeps an escaped \\? as a literal question mark and does not count it", () => {
    expect(positionBindings("SELECT meta \\? ? AND x = ?")).toBe(
      "SELECT meta ? $1 AND x = $2"
    );
  });
  it("leaves SQL without placeholders untouched", () => {
    expect(positionBindings("SELECT 1")).toBe("SELECT 1");
  });
});

describe("pgSqlClient", () => {
  it("rewrites the SQL, forwards the bindings and returns {rows,rowCount}", async () => {
    const calls: Array<{ sql: string; params: unknown[] | undefined }> = [];
    const client = {
      query: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        return { rows: [{ n: 1 }], rowCount: 1 };
      },
    };
    const db = pgSqlClient(client);
    const result = await db.raw("SELECT ?::int AS n", [1]);
    expect(calls).toEqual([{ sql: "SELECT $1::int AS n", params: [1] }]);
    expect(result).toEqual({ rows: [{ n: 1 }], rowCount: 1 });
  });
  it("passes an empty binding list when none is given", async () => {
    const calls: Array<{ params: unknown[] | undefined }> = [];
    const db = pgSqlClient({
      query: async (_sql: string, params?: unknown[]) => {
        calls.push({ params });
        return { rows: [], rowCount: 0 };
      },
    });
    await db.raw("SELECT 1");
    expect(calls[0]!.params).toEqual([]);
  });
});
