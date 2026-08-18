/**
 * `<Amount>` alongside `<Cost>` in the vendor bill QBXML payload — ADD and MOD,
 * symmetric.
 *
 * The bridge (quickbooks-bridge/src/qbxml/builders/bill.ts) now emits
 * `<Amount>` instead of `<Cost>` for any item line whose payload carries
 * `amount_cents` — QuickBooks derives the unit cost itself and holds the
 * total exactly, even when the division does not terminate (qty 11 +
 * `amount_cents` 25000 → QuickBooks-derived cost 22.72727..., bill stays at
 * $250.00 exact). `unit_cost_cents` keeps shipping unconditionally alongside
 * it — a bridge that has not picked up the Amount change yet still gets a
 * working `<Cost>` (compat matrix in the enqueue files' comments).
 *
 * `amount_cents` MUST come from the exact per-line total the landed-cost
 * engine produces (`allocateLineTotalsCents` / `computeLandedLines`'s
 * `landed_total_cents`), never from `landed_unit_cost_cents × qty` — that
 * per-unit figure is an INTEGER from `allocatePerUnitCents` and can strand up
 * to `qty − 1` cents of a pool (landed-allocation.ts §THE FIX). The China/
 * clearing-shape fixture below is built specifically to catch a regression
 * that sources `amount_cents` from the wrong place: its stored per-unit cost
 * disagrees with the freshly-allocated exact total by design.
 */

import {
  enqueueQbVendorBillAdd,
  type EnqueueKnex,
} from "../../lib/purchase-orders/qb-vendor-bill-enqueue";
import {
  enqueueChinaAgencyVendorBillModGroup,
  type VendorBillModKnex,
} from "../../lib/purchase-orders/qb-vendor-bill-mod-enqueue";

interface ItemLinePayload {
  vendor_bill_line_id: string;
  quantity: number;
  unit_cost_cents: number;
  amount_cents: number;
}

interface Payload {
  item_lines: ItemLinePayload[];
  expense_lines: Array<{ vendor_bill_line_id: string | null }>;
}

function extractPayload(calls: Array<{ bindings: unknown[] }>): Payload | null {
  for (const call of calls) {
    for (const binding of call.bindings) {
      if (typeof binding !== "string" || !binding.includes("item_lines")) {
        continue;
      }
      try {
        const parsed = JSON.parse(binding);
        if (parsed.item_lines) return parsed as Payload;
      } catch {
        // not the payload
      }
    }
  }
  return null;
}

// ── LOCAL / USA shape — no siblings, tax capitalized into the item cost ────

interface LocalProductLine {
  id: string;
  sku: string;
  qty: number;
  unit_cost_cents: number;
  qb_txn_line_id?: string | null;
}

interface LocalFixture {
  productLines: LocalProductLine[];
  taxAmountCents: number;
}

function fakeAddKnexLocal(fx: LocalFixture) {
  const calls: Array<{ sql: string; bindings: unknown[] }> = [];
  const handler = async (sql: string, bindings?: unknown[]) => {
    calls.push({ sql, bindings: bindings ?? [] });
    const q = sql.replace(/\s+/g, " ");

    if (q.includes("FROM vendor_bill vb")) {
      return {
        rows: [
          {
            id: "vb_1",
            number: "VB-9101",
            reference_id: "INV-1",
            document_date: "2026-08-01T12:00:00.000Z",
            due_date: "2026-08-31T12:00:00.000Z",
            purchase_order_id: "po_1",
            vendor_qb_list_id_snapshot: "800001C4-1380",
            vendor_name_snapshot: "Acme",
            qb_source: null,
            tax_amount_cents: fx.taxAmountCents,
            tax_account_list_id: null,
            freight_included: false,
            freight_amount_cents: 0,
            freight_allocation_basis: null,
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
      const rows = fx.productLines.map((l) => ({
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

  return { knex, payload: () => extractPayload(calls) };
}

function fakeModKnexLocal(fx: LocalFixture) {
  const calls: Array<{ sql: string; bindings: unknown[] }> = [];
  const handler = async (sql: string, bindings?: unknown[]) => {
    calls.push({ sql, bindings: bindings ?? [] });
    const q = sql.replace(/\s+/g, " ");

    if (q.includes("SELECT id, number, bill_type, purchase_order_id, reference_id,")) {
      return {
        rows: [
          {
            id: "vb_1",
            number: "VB-9101",
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
            tax_amount_cents: fx.taxAmountCents,
            freight_included: false,
            freight_allocation_basis: null,
          },
        ],
      };
    }
    if (q.includes("SELECT l.id, l.line_type, l.line_kind, l.qty,")) {
      const rows = fx.productLines.map((l) => ({
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

  return { knex, payload: () => extractPayload(calls) };
}

const localFixture: LocalFixture = {
  productLines: [
    { id: "l1", sku: "A", qty: 2, unit_cost_cents: 1000 },
    { id: "l2", sku: "B", qty: 3, unit_cost_cents: 2000 },
  ],
  // Not evenly divisible across the two lines' value weights (2000 / 8000
  // and 6000 / 8000) — forces a genuine largest-remainder split.
  taxAmountCents: 101,
};

// ── CHINA / clearing shape — one sibling (commission), landed item cost ────

interface ClearingFixture {
  qty: number;
  unitCostCents: number;
  /** Deliberately NOT what a fresh landed computation would give — the whole
   * point is to prove `amount_cents` is NOT sourced from this × qty. */
  storedLandedUnitCostCents: number;
  commissionTotalCents: number;
}

function fakeAddKnexClearing(fx: ClearingFixture) {
  const calls: Array<{ sql: string; bindings: unknown[] }> = [];
  const handler = async (sql: string, bindings?: unknown[]) => {
    calls.push({ sql, bindings: bindings ?? [] });
    const q = sql.replace(/\s+/g, " ");

    if (q.includes("FROM vendor_bill vb")) {
      return {
        rows: [
          {
            id: "vb_1",
            number: "VB-9102",
            reference_id: "INV-2",
            document_date: "2026-08-01T12:00:00.000Z",
            due_date: "2026-08-31T12:00:00.000Z",
            purchase_order_id: "po_1",
            vendor_qb_list_id_snapshot: "800001C4-1380",
            vendor_name_snapshot: "HK Agent",
            qb_source: null,
            tax_amount_cents: 0,
            tax_account_list_id: null,
            freight_included: false,
            freight_amount_cents: 0,
            freight_allocation_basis: null,
            rebuild_generation: 0,
          },
        ],
      };
    }
    if (q.includes("FROM purchase_order WHERE id")) {
      return {
        rows: [
          {
            number: "PO-2",
            qb_purchase_order_list_id: "800002A1-2222",
            vendor_id: "qbvnd_2",
          },
        ],
      };
    }
    if (q.includes("FROM vendor_bill reg")) {
      return {
        rows: [
          {
            vendor_bill_id: "svc_1",
            number: "VB-8001",
            bill_type: "service",
            qb_account_list_id: "800004C1-3333",
            qb_account_full_name: "Commission for Purchase:HK Agent",
            total_cents: fx.commissionTotalCents,
          },
        ],
      };
    }
    if (q.includes("FROM vendor_bill_line")) {
      return {
        rows: [
          {
            id: "l1",
            line_kind: "po_item",
            line_type: "product",
            sku: "SKU-CN",
            description: "SKU-CN",
            qty: fx.qty,
            unit_cost_cents: fx.unitCostCents,
            landed_unit_cost_cents: fx.storedLandedUnitCostCents,
            amount_cents: fx.qty * fx.unitCostCents,
            freight_account_list_id: null,
            qb_account_list_id: null,
            purchase_order_line_id: "pol_l1",
            qb_po_txn_line_id: "l1-txnline",
            variant_qb_item_list_id: "item-SKU-CN",
            cbm_per_unit: null,
          },
        ],
      };
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

  return { knex, payload: () => extractPayload(calls) };
}

function fakeModKnexClearing(fx: ClearingFixture) {
  const calls: Array<{ sql: string; bindings: unknown[] }> = [];
  const handler = async (sql: string, bindings?: unknown[]) => {
    calls.push({ sql, bindings: bindings ?? [] });
    const q = sql.replace(/\s+/g, " ");

    if (q.includes("SELECT id, number, bill_type, purchase_order_id, reference_id,")) {
      return {
        rows: [
          {
            id: "vb_1",
            number: "VB-9102",
            bill_type: "regular",
            purchase_order_id: "po_1",
            reference_id: "INV-2",
            document_date: "2026-08-01T12:00:00.000Z",
            due_date: "2026-08-31T12:00:00.000Z",
            qb_txn_id: "800009X1-2222",
            qb_edit_sequence: "7",
            qb_source: null,
            qb_clearing_lines: [
              {
                kind: "commission",
                account_list_id: "800004C1-3333",
                account_full_name: "Commission for Purchase:HK Agent",
                amount_cents: -fx.commissionTotalCents,
                qb_txn_line_id: "cl1-txnline",
              },
            ],
            // No live sibling — loadBillTotal falls back straight to this
            // header figure, same amount the Add's `siblings` query gave.
            service_vendor_bill_id: null,
            freight_vendor_bill_id: null,
            tariff_vendor_bill_id: null,
            commission_amount_cents: fx.commissionTotalCents,
            freight_amount_cents: 0,
            tariff_amount_cents: 0,
            tax_amount_cents: 0,
            freight_included: false,
            freight_allocation_basis: null,
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
            landed_unit_cost_cents: fx.storedLandedUnitCostCents,
            amount_cents: fx.qty * fx.unitCostCents,
            qb_txn_line_id: "l1-txnline",
            account_list_id: null,
            qb_item_list_id: "item-SKU-CN",
            cbm_per_unit: null,
            description: "SKU-CN",
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

  return { knex, payload: () => extractPayload(calls) };
}

// qty 11 + a $250.00 commission pool that does not divide evenly — the exact
// worked example from the plan: QuickBooks-derived Cost 22.72727..., bill
// stays exact at $250.00 when it is `<Amount>` that carries the total.
const clearingFixture: ClearingFixture = {
  qty: 11,
  unitCostCents: 1000, // $10.00/unit raw goods cost
  storedLandedUnitCostCents: 1022, // confirm-time per-unit (floor(250/11)=22 + 1000)
  commissionTotalCents: 25000, // $250.00 commission pool, 25000/11 does not terminate
};

describe("QuickBooks payload — amount_cents alongside unit_cost_cents (ADD + MOD, symmetric)", () => {
  const previousMode = process.env.QB_VENDOR_BILL_MODE;
  beforeAll(() => {
    process.env.QB_VENDOR_BILL_MODE = "bill";
  });
  afterAll(() => {
    process.env.QB_VENDOR_BILL_MODE = previousMode;
  });

  describe("local / USA shape", () => {
    it("ADD — item lines carry BOTH unit_cost_cents and amount_cents; Σ amount_cents = goods + tax, to the penny", async () => {
      const { knex, payload } = fakeAddKnexLocal(localFixture);
      const result = await enqueueQbVendorBillAdd(knex, "vb_1");
      expect(result.queued).toBe(true);
      const p = payload()!;
      expect(p.item_lines).toHaveLength(2);
      for (const line of p.item_lines) {
        expect(typeof line.unit_cost_cents).toBe("number");
        expect(Number.isFinite(line.unit_cost_cents)).toBe(true);
        expect(Number.isInteger(line.amount_cents)).toBe(true);
      }
      const goods = localFixture.productLines.reduce(
        (s, l) => s + l.unit_cost_cents * l.qty,
        0
      );
      const sumAmount = p.item_lines.reduce((s, l) => s + l.amount_cents, 0);
      expect(sumAmount).toBe(goods + localFixture.taxAmountCents);
    });

    it("MOD — same lines carry BOTH fields; Σ amount_cents matches the ADD exactly", async () => {
      const { knex, payload } = fakeModKnexLocal(localFixture);
      const result = await enqueueChinaAgencyVendorBillModGroup(knex, "vb_1");
      expect(result.queued).toBe(true);
      const p = payload()!;
      for (const line of p.item_lines) {
        expect(typeof line.unit_cost_cents).toBe("number");
        expect(Number.isInteger(line.amount_cents)).toBe(true);
      }
      const goods = localFixture.productLines.reduce(
        (s, l) => s + l.unit_cost_cents * l.qty,
        0
      );
      const sumAmount = p.item_lines.reduce((s, l) => s + l.amount_cents, 0);
      expect(sumAmount).toBe(goods + localFixture.taxAmountCents);
    });
  });

  describe("China / clearing shape — Σ(per_unit × qty) DIFFERS from the exact total", () => {
    it("ADD — amount_cents is the EXACT landed total, not stored landed_unit_cost_cents × qty", async () => {
      const { knex, payload } = fakeAddKnexClearing(clearingFixture);
      const result = await enqueueQbVendorBillAdd(knex, "vb_1");
      expect(result.queued).toBe(true);
      const p = payload()!;
      expect(p.item_lines).toHaveLength(1);
      const line = p.item_lines[0]!;

      // unit_cost_cents (guard: still shipped) is untouched — the stored,
      // confirm-time per-unit figure.
      expect(line.unit_cost_cents).toBe(clearingFixture.storedLandedUnitCostCents);

      // The naive (wrong) source: per-unit × qty strands the residue.
      const lossyTotal =
        clearingFixture.storedLandedUnitCostCents * clearingFixture.qty;
      const exactTotal =
        clearingFixture.unitCostCents * clearingFixture.qty +
        clearingFixture.commissionTotalCents;
      expect(lossyTotal).not.toBe(exactTotal); // sanity: the fixture actually drifts
      expect(line.amount_cents).toBe(exactTotal);
      expect(line.amount_cents).not.toBe(lossyTotal);
    });

    it("MOD — reproduces the SAME exact amount_cents as the ADD", async () => {
      const { knex, payload } = fakeModKnexClearing(clearingFixture);
      const result = await enqueueChinaAgencyVendorBillModGroup(knex, "vb_1");
      expect(result.queued).toBe(true);
      const p = payload()!;
      const line = p.item_lines[0]!;

      expect(line.unit_cost_cents).toBe(clearingFixture.storedLandedUnitCostCents);
      const exactTotal =
        clearingFixture.unitCostCents * clearingFixture.qty +
        clearingFixture.commissionTotalCents;
      expect(line.amount_cents).toBe(exactTotal);
    });
  });
});
