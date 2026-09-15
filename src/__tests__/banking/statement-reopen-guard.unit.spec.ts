import type { PoolClient } from "pg";

import {
  assertNoLaterClosedStatement,
  LATER_CLOSED_STATEMENT_SQL,
} from "../../lib/banking/statement-core";

/**
 * Reabrir un extracto con uno POSTERIOR cerrado de la misma cuenta rompe la cadena de
 * aperturas (la apertura de agosto es el cierre de julio) sin ningún aviso — el
 * `reopen` chequeaba Month Close pero no la cadena (2026-09-15). Sólo el extracto
 * cerrado MÁS RECIENTE de una cuenta se puede reabrir.
 */
function client(rows: Array<{ id: string; from_day: string; to_day: string }>) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const c = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      return { rows, rowCount: rows.length };
    },
  } as unknown as Pick<PoolClient, "query">;
  return { c, calls };
}
const july = { id: "bst_jul", account_list_id: "acct_7223", to: "2026-07-31" };

describe("assertNoLaterClosedStatement", () => {
  it("refuses to reopen July while August is closed (BANKING_STATEMENT_LATER_CLOSED, 409)", async () => {
    const { c, calls } = client([{ id: "bst_aug", from_day: "2026-08-01", to_day: "2026-08-31" }]);
    await expect(assertNoLaterClosedStatement(c, july)).rejects.toMatchObject({
      code: "BANKING_STATEMENT_LATER_CLOSED",
      status: 409,
    });
    expect(calls[0]!.params).toEqual(["acct_7223", "bst_jul", "2026-07-31"]);
  });
  it("lets the most recent closed statement reopen", async () => {
    const { c } = client([]);
    await expect(assertNoLaterClosedStatement(c, july)).resolves.toBeUndefined();
  });
  it("only CLOSED, LIVE statements of the SAME account dated AFTER this one count", () => {
    expect(LATER_CLOSED_STATEMENT_SQL).toMatch(/status='closed'/);
    expect(LATER_CLOSED_STATEMENT_SQL).toMatch(/deleted_at IS NULL/);
    expect(LATER_CLOSED_STATEMENT_SQL).toMatch(/account_list_id=\$1/);
    expect(LATER_CLOSED_STATEMENT_SQL).toMatch(/id<>\$2/);
    expect(LATER_CLOSED_STATEMENT_SQL).toMatch(/from_day>\$3/);
  });
});
