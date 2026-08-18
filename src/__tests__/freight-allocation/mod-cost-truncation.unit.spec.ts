/**
 * BillMod fail-closed guard: capitalized freight/tax must round-trip through
 * QuickBooks' 5-decimal `<Cost>` truncation (QBXML PRICETYPE; more decimals
 * triggers error 3045), same guard the Add already runs
 * (qb-vendor-bill-enqueue.ts) and the Mod ports (qb-vendor-bill-mod-enqueue.ts).
 *
 * Fixture: ONE product line, qty 2000 @ $10.00, with a $0.33 capitalized
 * freight pool riding entirely on that line. Exact item total is
 * 2000*1000 + 33 = 2,000,033c. QuickBooks' <Cost> can only carry 5 decimals
 * of a per-unit DOLLAR amount, and 2,000,033 / 2000 / 100 = $10.000165 does
 * not survive that truncation: round-tripped back through
 * quantity × truncated cost lands on 2,000,032c, one cent short.
 *
 * 2026-08-18 (owner): the guard that used to reject this fixture unconditionally
 * is now CONDITIONAL (qb-vendor-bill-cost-truncation-guard.ts) — it only fires
 * when a line's payload lacks a finite `amount_cents`. Every product line built
 * by this Mod carries one (the exact total, `raw*qty + taxShare + freightShare`),
 * so the bridge now ships `<Amount>` for this line instead of a divided-out
 * `<Cost>`: nothing is left to round-trip, and this SAME fixture must now be
 * ACCEPTED. That inversion is the point of this file surviving: it keeps
 * proving the Add and the Mod agree, just on the opposite verdict. The guard
 * itself still exists and still rejects — see
 * qb-vendor-bill-cost-truncation-guard.unit.spec.ts for the case where a line's
 * payload genuinely lacks `amount_cents`.
 *
 * Under a CAPITALIZED freight policy this now accepts (Amount carries the
 * total exactly). Under LEGACY the freight never enters `<Cost>` at all (it
 * stays its own ExpenseLine) and was never affected by this guard — the
 * identical fixture must still NOT reject, the 2-already-`synced`-bills
 * invariant the legacy path is not allowed to break.
 */

import {
  enqueueChinaAgencyVendorBillModGroup,
  type VendorBillModKnex,
} from "../../lib/purchase-orders/qb-vendor-bill-mod-enqueue";

interface Fixture {
  freightAllocationBasis: "units" | "value" | "cbm" | null;
  qty: number;
  unitCostCents: number;
  freightAmountCents: number;
}

function fakeModKnex(fx: Fixture) {
  const handler = async (sql: string, _bindings?: unknown[]) => {
    const q = sql.replace(/\s+/g, " ");

    if (q.includes("SELECT id, number, bill_type, purchase_order_id, reference_id,")) {
      return {
        rows: [
          {
            id: "vb_1",
            number: "VB-9002",
            bill_type: "regular",
            purchase_order_id: "po_1",
            reference_id: "INV-1",
            document_date: "2026-08-01T12:00:00.000Z",
            due_date: "2026-08-31T12:00:00.000Z",
            qb_txn_id: "800009X1-1111",
            qb_edit_sequence: "42",
            qb_source: null,
            qb_clearing_lines: [],
            service_vendor_bill_id: null,
            freight_vendor_bill_id: null,
            tariff_vendor_bill_id: null,
            commission_amount_cents: 0,
            freight_amount_cents: 0,
            tariff_amount_cents: 0,
            tax_amount_cents: 0,
            freight_included: false,
            freight_allocation_basis: fx.freightAllocationBasis,
          },
        ],
      };
    }
    if (q.includes("SELECT l.id, l.line_type, l.line_kind, l.qty,")) {
      return {
        rows: [
          {
            id: "l1",
            line_type: "product",
            line_kind: "po_item",
            qty: fx.qty,
            unit_cost_cents: fx.unitCostCents,
            landed_unit_cost_cents: fx.unitCostCents,
            amount_cents: fx.qty * fx.unitCostCents,
            qb_txn_line_id: "l1-txnline",
            account_list_id: null,
            qb_item_list_id: "item-A",
            cbm_per_unit: null,
            description: "A",
          },
          {
            id: "fl1",
            line_type: "qb_account",
            line_kind: "freight_charge",
            qty: 1,
            unit_cost_cents: fx.freightAmountCents,
            landed_unit_cost_cents: fx.freightAmountCents,
            amount_cents: fx.freightAmountCents,
            qb_txn_line_id: "fl1-txnline",
            account_list_id: "800003B1-2222",
            qb_item_list_id: null,
            cbm_per_unit: null,
            description: "Freight",
          },
        ],
      };
    }
    if (q.includes("FROM qb_vendor_bill_pipeline")) return { rows: [] };
    if (q.includes("INSERT INTO") && q.includes("RETURNING")) {
      return { rows: [{ id: "row_1" }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };

  const knex = {
    raw: handler,
    transaction: async <T>(fn: (trx: VendorBillModKnex) => Promise<T>) =>
      fn({ raw: handler } as unknown as VendorBillModKnex),
  } as unknown as VendorBillModKnex;
  return { knex };
}

describe("BillMod — <Cost> 5-decimal truncation guard (capitalized freight)", () => {
  const previousMode = process.env.QB_VENDOR_BILL_MODE;
  beforeAll(() => {
    process.env.QB_VENDOR_BILL_MODE = "bill";
  });
  afterAll(() => {
    process.env.QB_VENDOR_BILL_MODE = previousMode;
  });

  const nonRoundTrippingFixture: Fixture = {
    freightAllocationBasis: "units",
    qty: 2000,
    unitCostCents: 1000,
    freightAmountCents: 33,
  };

  it("capitalized policy: a <Cost> that does not round-trip to 5 decimals is ACCEPTED — the line carries a finite amount_cents, so <Amount> ships instead", async () => {
    const { knex } = fakeModKnex(nonRoundTrippingFixture);
    const result = await enqueueChinaAgencyVendorBillModGroup(knex, "vb_1");
    expect(result.queued).toBe(true);
  });

  it("capitalized policy: a <Cost> that DOES round-trip passes", async () => {
    const { knex } = fakeModKnex({
      freightAllocationBasis: "units",
      qty: 2,
      unitCostCents: 1000,
      freightAmountCents: 500,
    });
    const result = await enqueueChinaAgencyVendorBillModGroup(knex, "vb_1");
    expect(result.queued).toBe(true);
  });

  it("legacy policy (NULL basis): the SAME non-round-tripping fixture is NOT rejected — freight never enters <Cost>", async () => {
    const { knex } = fakeModKnex({
      ...nonRoundTrippingFixture,
      freightAllocationBasis: null,
    });
    const result = await enqueueChinaAgencyVendorBillModGroup(knex, "vb_1");
    expect(result.queued).toBe(true);
  });
});
