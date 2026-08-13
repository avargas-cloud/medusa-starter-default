/**
 * Unit tests for the Billed column's state derivation.
 *
 * The question the column answers is "is this purchase order fully invoiced by
 * the vendor", so the yardstick is what was ORDERED, not what has arrived.
 * Measuring against receipts made PO-1119 (ET2) read `yes` while 3 of its 10
 * ordered units were still uninvoiced: 7 received and 7 billed satisfied
 * `billed >= received`, and the 3 units nobody had billed were invisible.
 *
 * The one case that must NOT move is the adopted header-only bill: it has zero
 * lines by design (the accountant's QB bill imported during reconciliation), so
 * its billed quantity is always 0 and any ordered-based rule would call it
 * `partial` forever. It stays a positive assertion of `yes`.
 */

import {
  deriveBilledStatus,
  enrichBilledStatusMap,
} from "../../api/admin/purchase-orders/_lib/billed-status";

describe("deriveBilledStatus", () => {
  it("is 'no' when nothing is billed", () => {
    expect(
      deriveBilledStatus({
        billedQty: 0,
        hasAdoptedZeroLineBill: false,
        billableOrderedQty: 10,
      }).billed_status
    ).toBe("no");
  });

  it("is 'partial' when the vendor billed everything RECEIVED but not everything ORDERED (PO-1119)", () => {
    // 10 ordered, 7 received, 7 billed across VB-1076 (2u) and VB-1080 (5u).
    // The old rule answered `yes` here — this is the case that motivated the change.
    expect(
      deriveBilledStatus({
        billedQty: 7,
        hasAdoptedZeroLineBill: false,
        billableOrderedQty: 10,
      })
    ).toEqual({ billed_status: "partial", billed_qty: 7 });
  });

  it("is 'yes' once the billed quantity covers everything ordered", () => {
    expect(
      deriveBilledStatus({
        billedQty: 10,
        hasAdoptedZeroLineBill: false,
        billableOrderedQty: 10,
      }).billed_status
    ).toBe("yes");
  });

  it("stays 'yes' when the vendor over-bills the order", () => {
    expect(
      deriveBilledStatus({
        billedQty: 12,
        hasAdoptedZeroLineBill: false,
        billableOrderedQty: 10,
      }).billed_status
    ).toBe("yes");
  });

  it("is 'partial' when the vendor bills ahead of the goods but not in full", () => {
    // Nothing has arrived yet. Invoicing 4 of 10 up front is normal, and it is
    // still an order that is only partly invoiced.
    expect(
      deriveBilledStatus({
        billedQty: 4,
        hasAdoptedZeroLineBill: false,
        billableOrderedQty: 10,
      }).billed_status
    ).toBe("partial");
  });

  it("is 'yes' when a bill arrives ahead of the goods and covers the whole order", () => {
    expect(
      deriveBilledStatus({
        billedQty: 10,
        hasAdoptedZeroLineBill: false,
        billableOrderedQty: 10,
      }).billed_status
    ).toBe("yes");
  });

  it("keeps an adopted zero-line bill at 'yes' even though it bills 0 units", () => {
    // 64 POs in production are in exactly this shape. An ordered-based rule
    // without this branch would flip every one of them to 'partial'.
    expect(
      deriveBilledStatus({
        billedQty: 0,
        hasAdoptedZeroLineBill: true,
        billableOrderedQty: 10,
      }).billed_status
    ).toBe("yes");
  });

  it("is 'yes' when a bill exists and every line was cancelled", () => {
    // Nothing is left to demand, so nothing can be outstanding.
    expect(
      deriveBilledStatus({
        billedQty: 3,
        hasAdoptedZeroLineBill: false,
        billableOrderedQty: 0,
      }).billed_status
    ).toBe("yes");
  });

  it("reports the billed quantity unchanged in every branch", () => {
    expect(
      deriveBilledStatus({
        billedQty: 7,
        hasAdoptedZeroLineBill: false,
        billableOrderedQty: 10,
      }).billed_qty
    ).toBe(7);
  });
});

/** Captures the SQL + bindings and replays canned rows back. */
function fakeKnex(rows: Array<Record<string, unknown>>) {
  const calls: Array<{ sql: string; bindings: unknown[] }> = [];
  return {
    calls,
    db: {
      raw: async (sql: string, bindings?: unknown[]) => {
        calls.push({ sql, bindings: bindings ?? [] });
        return { rows };
      },
    },
  };
}

describe("enrichBilledStatusMap", () => {
  it("asks Postgres for the ordered quantity, not just the billed one", () => {
    // Without this the route would have to fall back to `total_units_received`
    // on the row, which is precisely the yardstick being replaced.
    const { calls, db } = fakeKnex([]);
    return enrichBilledStatusMap(db, [{ id: "po_1" }]).then(() => {
      expect(calls).toHaveLength(1);
      expect(calls[0].sql).toContain("qty_ordered");
      expect(calls[0].sql).toContain("qty_cancelled");
    });
  });

  it("derives 'partial' for a PO whose ordered quantity outruns its bills", () => {
    const { db } = fakeKnex([
      {
        po_id: "po_1",
        billed_qty: 7,
        has_adopted_zero_line: false,
        billable_ordered_qty: 10,
      },
    ]);
    return enrichBilledStatusMap(db, [
      { id: "po_1", total_units_received: 7 },
    ]).then((map) => {
      expect(map.get("po_1")?.billed_status).toBe("partial");
      expect(map.get("po_1")?.billed_qty).toBe(7);
    });
  });

  it("leaves a PO with no qualifying bill at 'no'", () => {
    const { db } = fakeKnex([]);
    return enrichBilledStatusMap(db, [
      { id: "po_1", total_units_received: 4 },
    ]).then((map) => {
      expect(map.get("po_1")?.billed_status).toBe("no");
    });
  });

  it("short-circuits without querying when given no rows", () => {
    const { calls, db } = fakeKnex([]);
    return enrichBilledStatusMap(db, []).then((map) => {
      expect(map.size).toBe(0);
      expect(calls).toHaveLength(0);
    });
  });
});
