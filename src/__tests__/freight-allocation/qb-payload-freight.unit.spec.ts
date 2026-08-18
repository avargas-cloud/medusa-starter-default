/**
 * Capitalized freight in the QuickBooks payload — ADD and MOD, symmetric.
 *
 * `vendor_bill.freight_allocation_basis`:
 *   NULL     → legacy. The bill's `freight_charge` line ships as its own
 *              positive ExpenseLine, byte for byte as today (the guard 2 of
 *              the bills already `synced` in production depend on: their
 *              freight line carries a real `qb_txn_line_id`, and `BillMod`
 *              deletes by omission).
 *   non-null → capitalized. The freight_charge pool is spread across the
 *              item lines' `<Cost>` (same engine as sales tax) and the
 *              `freight_charge` line itself is excluded from the payload.
 *
 * Both builders are driven through their REAL exported functions with a fake
 * connection — asserting on a re-implementation of the filter would prove
 * nothing about what actually ships.
 */

import {
  enqueueQbVendorBillAdd,
  type EnqueueKnex,
} from "../../lib/purchase-orders/qb-vendor-bill-enqueue";
import {
  enqueueChinaAgencyVendorBillModGroup,
  type VendorBillModKnex,
} from "../../lib/purchase-orders/qb-vendor-bill-mod-enqueue";

interface ProductLine {
  id: string;
  sku: string;
  qty: number;
  unit_cost_cents: number;
  qb_txn_line_id?: string | null;
}

interface FreightLine {
  id: string;
  amount_cents: number;
  qb_txn_line_id?: string | null;
}

interface Fixture {
  freightAllocationBasis: "units" | "value" | "cbm" | null;
  productLines: ProductLine[];
  freightLine: FreightLine | null;
}

// ── ADD fake connection ─────────────────────────────────────────────────────

function fakeAddKnex(fx: Fixture) {
  const calls: Array<{ sql: string; bindings: unknown[] }> = [];
  const handler = async (sql: string, bindings?: unknown[]) => {
    calls.push({ sql, bindings: bindings ?? [] });
    const q = sql.replace(/\s+/g, " ");

    if (q.includes("FROM vendor_bill vb")) {
      return {
        rows: [
          {
            id: "vb_1",
            number: "VB-9001",
            reference_id: "INV-1",
            document_date: "2026-08-01T12:00:00.000Z",
            due_date: "2026-08-31T12:00:00.000Z",
            purchase_order_id: "po_1",
            vendor_qb_list_id_snapshot: "800001C4-1380",
            vendor_name_snapshot: "Acme",
            qb_source: null,
            tax_amount_cents: 0,
            tax_account_list_id: null,
            freight_included: false,
            freight_amount_cents: 0,
            freight_allocation_basis: fx.freightAllocationBasis,
            rebuild_generation: 0,
          },
        ],
      };
    }
    if (q.includes("FROM purchase_order WHERE id")) {
      return {
        rows: [
          {
            number: "PO-1",
            qb_purchase_order_list_id: "800002A1-1111",
            vendor_id: "qbvnd_1",
          },
        ],
      };
    }
    if (q.includes("FROM vendor_bill reg")) return { rows: [] }; // no siblings
    if (q.includes("FROM vendor_bill_line")) {
      const rows: Record<string, unknown>[] = fx.productLines.map((l) => ({
        id: l.id,
        line_kind: "po_item",
        line_type: "product",
        sku: l.sku,
        description: l.sku,
        qty: l.qty,
        unit_cost_cents: l.unit_cost_cents,
        landed_unit_cost_cents: l.unit_cost_cents,
        amount_cents: l.qty * l.unit_cost_cents,
        freight_account_list_id: null,
        qb_account_list_id: null,
        purchase_order_line_id: `pol_${l.id}`,
        qb_po_txn_line_id: `${l.id}-txnline`,
        variant_qb_item_list_id: `item-${l.sku}`,
        cbm_per_unit: null,
      }));
      if (fx.freightLine) {
        rows.push({
          id: fx.freightLine.id,
          line_kind: "freight_charge",
          line_type: "qb_account",
          sku: "FREIGHT",
          description: "Freight",
          qty: 1,
          unit_cost_cents: fx.freightLine.amount_cents,
          landed_unit_cost_cents: fx.freightLine.amount_cents,
          amount_cents: fx.freightLine.amount_cents,
          freight_account_list_id: "800003B1-2222",
          qb_account_list_id: "800003B1-2222",
          purchase_order_line_id: null,
          qb_po_txn_line_id: null,
          variant_qb_item_list_id: null,
          cbm_per_unit: null,
        });
      }
      return { rows };
    }
    if (q.includes("INSERT INTO") && q.includes("RETURNING")) {
      return { rows: [{ id: "qvb_1" }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };

  const knex = {
    raw: handler,
    transaction: async () => ({
      raw: handler,
      commit: async () => {},
      rollback: async () => {},
    }),
  } as unknown as EnqueueKnex;

  const payload = (): {
    item_lines: Array<{ vendor_bill_line_id: string; unit_cost_cents: number }>;
    expense_lines: Array<{ vendor_bill_line_id: string | null }>;
  } | null => {
    for (const call of calls) {
      for (const binding of call.bindings) {
        if (typeof binding !== "string" || !binding.includes("item_lines")) {
          continue;
        }
        try {
          const parsed = JSON.parse(binding);
          if (parsed.item_lines) return parsed;
        } catch {
          // not the payload
        }
      }
    }
    return null;
  };

  return { knex, payload };
}

// ── MOD fake connection ─────────────────────────────────────────────────────

function fakeModKnex(fx: Fixture) {
  const calls: Array<{ sql: string; bindings: unknown[] }> = [];
  const handler = async (sql: string, bindings?: unknown[]) => {
    calls.push({ sql, bindings: bindings ?? [] });
    const q = sql.replace(/\s+/g, " ");

    if (q.includes("SELECT id, number, bill_type, purchase_order_id, reference_id,")) {
      return {
        rows: [
          {
            id: "vb_1",
            number: "VB-9001",
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
      const rows: Record<string, unknown>[] = fx.productLines.map((l) => ({
        id: l.id,
        line_type: "product",
        line_kind: "po_item",
        qty: l.qty,
        unit_cost_cents: l.unit_cost_cents,
        landed_unit_cost_cents: l.unit_cost_cents,
        amount_cents: l.qty * l.unit_cost_cents,
        qb_txn_line_id: l.qb_txn_line_id ?? `${l.id}-txnline`,
        account_list_id: null,
        qb_item_list_id: `item-${l.sku}`,
        cbm_per_unit: null,
        description: l.sku,
      }));
      if (fx.freightLine) {
        rows.push({
          id: fx.freightLine.id,
          line_type: "qb_account",
          line_kind: "freight_charge",
          qty: 1,
          unit_cost_cents: fx.freightLine.amount_cents,
          landed_unit_cost_cents: fx.freightLine.amount_cents,
          amount_cents: fx.freightLine.amount_cents,
          qb_txn_line_id: fx.freightLine.qb_txn_line_id ?? null,
          account_list_id: "800003B1-2222",
          qb_item_list_id: null,
          cbm_per_unit: null,
          description: "Freight",
        });
      }
      return { rows };
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

  const payload = (): {
    item_lines: Array<{ vendor_bill_line_id: string; unit_cost_cents: number }>;
    expense_lines: Array<{ vendor_bill_line_id: string | null }>;
  } | null => {
    for (const call of calls) {
      for (const binding of call.bindings) {
        if (typeof binding !== "string" || !binding.includes("item_lines")) {
          continue;
        }
        try {
          const parsed = JSON.parse(binding);
          if (parsed.item_lines) return parsed;
        } catch {
          // not the payload
        }
      }
    }
    return null;
  };

  return { knex, payload };
}

const baseFixture = (
  freightAllocationBasis: Fixture["freightAllocationBasis"]
): Fixture => ({
  freightAllocationBasis,
  productLines: [
    { id: "l1", sku: "A", qty: 2, unit_cost_cents: 1000 },
    { id: "l2", sku: "B", qty: 3, unit_cost_cents: 2000 },
  ],
  freightLine: { id: "fl1", amount_cents: 500, qb_txn_line_id: "fl1-txnline" },
});

describe("QuickBooks payload — capitalized freight (ADD + MOD, symmetric)", () => {
  const previousMode = process.env.QB_VENDOR_BILL_MODE;
  beforeAll(() => {
    process.env.QB_VENDOR_BILL_MODE = "bill";
  });
  afterAll(() => {
    process.env.QB_VENDOR_BILL_MODE = previousMode;
  });

  it("ADD — legacy (NULL basis): expense_lines CONTAINS the freight_charge line", async () => {
    const { knex, payload } = fakeAddKnex(baseFixture(null));
    const result = await enqueueQbVendorBillAdd(knex, "vb_1");
    expect(result.queued).toBe(true);
    const p = payload()!;
    expect(p.expense_lines.some((l) => l.vendor_bill_line_id === "fl1")).toBe(
      true
    );
  });

  it("MOD — legacy (NULL basis): expense_lines CONTAINS the freight_charge line", async () => {
    const { knex, payload } = fakeModKnex(baseFixture(null));
    const result = await enqueueChinaAgencyVendorBillModGroup(knex, "vb_1");
    expect(result.queued).toBe(true);
    const p = payload()!;
    expect(p.expense_lines.some((l) => l.vendor_bill_line_id === "fl1")).toBe(
      true
    );
  });

  it("ADD — capitalized ('units'): expense_lines does NOT contain the freight_charge line", async () => {
    const { knex, payload } = fakeAddKnex(baseFixture("units"));
    const result = await enqueueQbVendorBillAdd(knex, "vb_1");
    expect(result.queued).toBe(true);
    const p = payload()!;
    expect(p.expense_lines.some((l) => l.vendor_bill_line_id === "fl1")).toBe(
      false
    );
  });

  it("MOD — capitalized ('units'): expense_lines does NOT contain the freight_charge line", async () => {
    const { knex, payload } = fakeModKnex(baseFixture("units"));
    const result = await enqueueChinaAgencyVendorBillModGroup(knex, "vb_1");
    expect(result.queued).toBe(true);
    const p = payload()!;
    expect(p.expense_lines.some((l) => l.vendor_bill_line_id === "fl1")).toBe(
      false
    );
  });

  it("ADD — capitalized ('units'): Σ(item cost) = goods + tax(0) + freight, to the penny", async () => {
    const { knex, payload } = fakeAddKnex(baseFixture("units"));
    await enqueueQbVendorBillAdd(knex, "vb_1");
    const p = payload()!;
    // l1: qty2 @ 1000c, l2: qty3 @ 2000c — goods = 2000 + 6000 = 8000c.
    // freight pool 500c spread by 'units' weight [2,3] → [200,300] exactly.
    const totalItemCost = p.item_lines.reduce(
      (s, l) => s + l.unit_cost_cents * (l as unknown as { quantity: number }).quantity,
      0
    );
    expect(Math.round(totalItemCost)).toBe(8000 + 500);
  });

  it("MOD — capitalized ('units'): Σ(item cost) = goods + tax(0) + freight, to the penny", async () => {
    const { knex, payload } = fakeModKnex(baseFixture("units"));
    await enqueueChinaAgencyVendorBillModGroup(knex, "vb_1");
    const p = payload()!;
    const totalItemCost = p.item_lines.reduce(
      (s, l) => s + l.unit_cost_cents * (l as unknown as { quantity: number }).quantity,
      0
    );
    expect(Math.round(totalItemCost)).toBe(8000 + 500);
  });

  it("ADD — fail-closed: freight that cannot be placed (basis 'value', all product lines cost 0) refuses to queue", async () => {
    const fx = baseFixture("value");
    fx.productLines = [
      { id: "l1", sku: "A", qty: 2, unit_cost_cents: 0 },
      { id: "l2", sku: "B", qty: 3, unit_cost_cents: 0 },
    ];
    const { knex } = fakeAddKnex(fx);
    const result = await enqueueQbVendorBillAdd(knex, "vb_1");
    expect(result.queued).toBe(false);
    if (!result.queued) {
      expect(result.reason).toMatch(/freight/i);
    }
  });
});
