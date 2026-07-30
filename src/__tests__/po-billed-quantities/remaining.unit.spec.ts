/**
 * Unit tests for the PO "still billable" arithmetic that lets one purchase
 * order carry several regular vendor bills.
 *
 * The load-bearing case is the self-exclusion: a bill validating its own save
 * must not count its own lines as already billed, or a line it already holds
 * would compute 0 remaining and refuse to save the quantity it is sitting on.
 */

import {
  ACTIVE_BILL_STATUSES,
  qtyExceedsRemainingMessage,
  resolveRemainingPoQuantities,
  seedableLines,
  totalRemaining,
  type RemainingPoLine,
} from "../../lib/purchase-orders/po-billed-quantities";

function line(over: Partial<RemainingPoLine> = {}): RemainingPoLine {
  return {
    purchase_order_line_id: "pol_1",
    product_variant_id: "variant_1",
    sku_snapshot: "SKU-1",
    description_snapshot: "Widget",
    qty_ordered: 10,
    qty_billed: 0,
    qty_remaining: 10,
    unit_cost_cents: 1000,
    metadata: null,
    billed_on: null,
    ...over,
  };
}

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

describe("resolveRemainingPoQuantities", () => {
  it("only draft/confirmed/synced bills reserve quantity", () => {
    // cancelled and voided leave deleted_at NULL, so the status allowlist —
    // not the soft-delete column — is what releases their quantity.
    expect([...ACTIVE_BILL_STATUSES]).toEqual(["draft", "confirmed", "synced"]);
    expect(ACTIVE_BILL_STATUSES).not.toContain("cancelled");
    expect(ACTIVE_BILL_STATUSES).not.toContain("voided");
    expect(ACTIVE_BILL_STATUSES).not.toContain("deleted");
  });

  it("binds the caller's own bill id so it excludes itself", async () => {
    const { db, calls } = fakeKnex([]);
    await resolveRemainingPoQuantities(db, "po_1", "vb_self");

    expect(calls).toHaveLength(1);
    expect(calls[0].bindings).toEqual([
      ["draft", "confirmed", "synced"],
      "vb_self",
      "vb_self",
      "po_1",
    ]);
    // The exclusion has to be a no-op when nobody is editing a bill, which is
    // why it is written as a nullable guard rather than an unconditional <>.
    expect(calls[0].sql).toContain("?::text IS NULL OR vb.id <> ?::text");
  });

  it("passes NULL for the exclusion when creating a brand new bill", async () => {
    const { db, calls } = fakeKnex([]);
    await resolveRemainingPoQuantities(db, "po_1");
    expect(calls[0].bindings[1]).toBeNull();
    expect(calls[0].bindings[2]).toBeNull();
  });

  it("coerces numeric columns that Postgres hands back as strings", async () => {
    // Project-wide rule: a numeric column from pg can arrive as a string and
    // `"8" + 0` concatenates. Coercion belongs here, not at each call site.
    const { db } = fakeKnex([
      {
        purchase_order_line_id: "pol_1",
        product_variant_id: "variant_1",
        sku_snapshot: "SKU-1",
        description_snapshot: "Widget",
        qty_ordered: "10",
        qty_billed: "2",
        qty_remaining: "8",
        unit_cost_cents: "1000",
        metadata: null,
        billed_on: "VB-1076",
      },
    ]);
    const [row] = await resolveRemainingPoQuantities(db, "po_1");

    expect(row.qty_ordered).toBe(10);
    expect(row.qty_billed).toBe(2);
    expect(row.qty_remaining).toBe(8);
    expect(row.unit_cost_cents).toBe(1000);
    expect(row.qty_remaining + 0).toBe(8);
  });

  it("defaults a line nobody has billed to zero billed, not null", async () => {
    const { db } = fakeKnex([
      {
        purchase_order_line_id: "pol_2",
        product_variant_id: "variant_2",
        sku_snapshot: "SKU-2",
        description_snapshot: "Gadget",
        qty_ordered: 6,
        qty_billed: 0,
        qty_remaining: 6,
        unit_cost_cents: 500,
        metadata: null,
        billed_on: null,
      },
    ]);
    const [row] = await resolveRemainingPoQuantities(db, "po_1");
    expect(row.qty_billed).toBe(0);
    expect(row.billed_on).toBeNull();
  });
});

describe("seedableLines", () => {
  it("keeps only what is still unbilled", () => {
    const lines = [
      line({ purchase_order_line_id: "a", qty_remaining: 0, qty_billed: 10 }),
      line({ purchase_order_line_id: "b", qty_remaining: 8, qty_billed: 2 }),
      line({ purchase_order_line_id: "c", qty_remaining: 6, qty_billed: 0 }),
    ];
    expect(seedableLines(lines).map((l) => l.purchase_order_line_id)).toEqual([
      "b",
      "c",
    ]);
  });

  it("is empty when the PO is fully billed", () => {
    expect(seedableLines([line({ qty_remaining: 0, qty_billed: 10 })])).toEqual(
      []
    );
  });
});

describe("totalRemaining", () => {
  it("sums the remainder across lines", () => {
    // PO-1119: 10 ordered, 2 on VB-1076, 8 left.
    expect(
      totalRemaining([
        line({ qty_ordered: 1, qty_billed: 1, qty_remaining: 0 }),
        line({ qty_ordered: 1, qty_billed: 1, qty_remaining: 0 }),
        line({ qty_ordered: 1, qty_billed: 0, qty_remaining: 1 }),
        line({ qty_ordered: 1, qty_billed: 0, qty_remaining: 1 }),
        line({ qty_ordered: 6, qty_billed: 0, qty_remaining: 6 }),
      ])
    ).toBe(8);
  });

  it("is zero for an empty PO", () => {
    expect(totalRemaining([])).toBe(0);
  });
});

describe("qtyExceedsRemainingMessage", () => {
  it("names the bill holding the difference", () => {
    const message = qtyExceedsRemainingMessage(
      { qty_remaining: 8, qty_ordered: 10, qty_billed: 2, billed_on: "VB-1076" },
      "ET2-E30318-BK"
    );
    expect(message).toContain("Max is 8");
    expect(message).toContain("ET2-E30318-BK");
    expect(message).toContain("VB-1076");
    expect(message).toContain("2 of the 10 ordered");
  });

  it("says units, singular, when exactly one is parked elsewhere", () => {
    const message = qtyExceedsRemainingMessage({
      qty_remaining: 0,
      qty_ordered: 1,
      qty_billed: 1,
      billed_on: "VB-1076",
    });
    expect(message).toBe(
      "Max is 0 — 1 of the 1 ordered unit is already billed on VB-1076."
    );
  });

  it("falls back to the PO-quantity wording when no sibling bill is involved", () => {
    // Nothing billed elsewhere means the operator simply typed more than the
    // PO ordered — pointing at a sibling bill would be a lie.
    const message = qtyExceedsRemainingMessage(
      { qty_remaining: 10, qty_ordered: 10, qty_billed: 0, billed_on: null },
      "SKU-1"
    );
    expect(message).toBe(
      "Max is the PO quantity (10) for SKU-1. Edit the PO to add more."
    );
  });
});
