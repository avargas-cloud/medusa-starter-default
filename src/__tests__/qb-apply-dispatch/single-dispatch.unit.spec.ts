/**
 * claimApplyPaymentRow — the cross-process gate that stops SERVER and WORKER
 * from both firing a ReceivePaymentMod for the same application.
 *
 * WHAT THIS SPEC CAN AND CANNOT SHOW
 * The pool is a fake, so the SQL never executes — this spec fixes the DECISION
 * (claim / refuse / no-row), not the statement. Whether the UPDATE's status
 * predicate actually matches is proven by the sandbox E2E against real Postgres,
 * because a spec with a fake pool has shipped a silently-dead gate in this repo
 * before.
 *
 * Incident this encodes: 2026-07-30, order 2866 / PAY-3309 / INV-21259. SERVER
 * dispatched at 14:14:29 and WORKER dispatched the same apply at 14:15:29; the
 * loser died with QuickBooks Error 3200.
 */
import { claimApplyPaymentRow } from "../../lib/quickbooks/handlers/handle-pos-payment-applied";

type Call = { sql: string; params?: unknown[] };

/** Fake pool: first query returns the current row, second returns the claim. */
function fakePool(current: any[], claimed: any[]) {
  const calls: Call[] = [];
  return {
    calls,
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      return { rows: sql.trim().startsWith("SELECT") ? current : claimed };
    },
  };
}

const ORDER = "order_1";
const REF = "papp_1";

describe("claimApplyPaymentRow", () => {
  it("claims a row nobody owns", async () => {
    const pool = fakePool([{ id: "row1", status: "waiting" }], [{ id: "row1" }]);
    await expect(
      claimApplyPaymentRow(pool, ORDER, REF, null)
    ).resolves.toEqual({ outcome: "claimed" });
  });

  it("refuses when the UPDATE matches nothing — another dispatcher holds it", async () => {
    // status 'processing' is outside the claimable set, so the UPDATE returns 0
    // rows. This is the SERVER-vs-WORKER collision.
    const pool = fakePool([{ id: "row1", status: "processing" }], []);
    await expect(claimApplyPaymentRow(pool, ORDER, REF, null)).resolves.toEqual({
      outcome: "held_by_other",
      rowId: "row1",
      status: "processing",
    });
  });

  it("refuses a row that already confirmed", async () => {
    const pool = fakePool([{ id: "row1", status: "confirmed" }], []);
    const res = await claimApplyPaymentRow(pool, ORDER, REF, null);
    expect(res.outcome).toBe("held_by_other");
  });

  it("lets the consolidator through on the row it already claimed", async () => {
    // The consolidator sets 'processing' via FOR UPDATE SKIP LOCKED before
    // calling. Without this branch it would refuse to dispatch on its own lock.
    const pool = fakePool([{ id: "row1", status: "processing" }], []);
    await expect(
      claimApplyPaymentRow(pool, ORDER, REF, "row1")
    ).resolves.toEqual({ outcome: "claimed" });
    // Short-circuits: it must not even attempt the UPDATE.
    expect(pool.calls).toHaveLength(1);
  });

  it("does NOT short-circuit for a different row id", async () => {
    const pool = fakePool([{ id: "row1", status: "processing" }], []);
    const res = await claimApplyPaymentRow(pool, ORDER, REF, "some-other-row");
    expect(res.outcome).toBe("held_by_other");
  });

  it("reports no_row when there is nothing to exclude against", async () => {
    const pool = fakePool([], []);
    await expect(claimApplyPaymentRow(pool, ORDER, REF, null)).resolves.toEqual({
      outcome: "no_row",
    });
  });

  it("only ever claims from waiting/pending/failed", async () => {
    const pool = fakePool([{ id: "row1", status: "waiting" }], [{ id: "row1" }]);
    await claimApplyPaymentRow(pool, ORDER, REF, null);
    const update = pool.calls.find((c) => c.sql.includes("UPDATE"));
    expect(update).toBeDefined();
    expect(update!.sql).toContain("'waiting', 'pending', 'failed'");
    // Never claimable: dispatching over these is the duplicate we are stopping.
    for (const terminal of ["submitted", "confirmed", "fixed", "skipped"]) {
      expect(update!.sql).not.toContain(`'${terminal}'`);
    }
  });
});
