/**
 * A vendor bill line left at quantity 0 must not reach QuickBooks.
 *
 * Zeroing lines is how a partial vendor invoice gets built — the operator seeds
 * the bill from the PO and drops to 0 whatever this invoice does not cover — so
 * this is the ordinary path, not an edge case. Our own arithmetic already
 * ignores those rows (totals, landed allocation, the PO remainder), which is
 * exactly why the defect was invisible: the payload builder filtered product
 * lines by line_type and line_kind and never looked at the quantity, so each
 * zeroed row still went out as an ItemLine with Quantity 0 and landed as an
 * empty row on the Bill in QuickBooks Desktop.
 *
 * The bill is driven through the real `enqueueQbVendorBillAdd` with a fake
 * connection, and the payload it hands the pipeline is read back — asserting on
 * a re-implementation of the filter would prove nothing about the shipped one.
 */

import {
  enqueueQbVendorBillAdd,
  type EnqueueKnex,
} from "../../lib/purchase-orders/qb-vendor-bill-enqueue";

interface Line {
  id: string;
  sku: string;
  qty: number;
  unit_cost_cents: number;
  line_type?: string;
  line_kind?: string;
}

/**
 * Answers the enqueue's queries by matching on the statement, and keeps every
 * call so the payload written to the pipeline can be recovered afterwards.
 */
function fakeKnex(lines: Line[]) {
  const calls: Array<{ sql: string; bindings: unknown[] }> = [];
  const handler = async (sql: string, bindings?: unknown[]) => {
    {
      calls.push({ sql, bindings: bindings ?? [] });
      const q = sql.replace(/\s+/g, " ");

      if (q.includes("FROM vendor_bill vb")) {
        return {
          rows: [{
            id: "vb_1", number: "VB-1094", reference_id: "INV-77",
            document_date: "2026-07-30T12:00:00.000Z",
            due_date: "2026-08-29T12:00:00.000Z",
            purchase_order_id: "po_1",
            vendor_qb_list_id_snapshot: "800001C4-1380",
            vendor_name_snapshot: "ET2", qb_source: null,
            tax_amount_cents: 0, tax_account_list_id: null,
            rebuild_generation: 0,
          }],
        };
      }
      if (q.includes("FROM purchase_order WHERE id")) {
        return {
          rows: [{
            number: "PO-1119",
            qb_purchase_order_list_id: "800002A1-1111",
            vendor_id: "qbvnd_1",
          }],
        };
      }
      // Not a China agent — keeps this on the local/USA path.
      if (q.includes("FROM qb_vendor")) return { rows: [] };
      if (q.includes("FROM vendor_bill_line")) {
        return {
          rows: lines.map((l) => ({
            id: l.id,
            line_kind: l.line_kind ?? "po_item",
            line_type: l.line_type ?? "product",
            sku: l.sku,
            description: l.sku,
            qty: l.qty,
            unit_cost_cents: l.unit_cost_cents,
            amount_cents: l.qty * l.unit_cost_cents,
            freight_account_list_id: null,
            qb_account_list_id: null,
            purchase_order_line_id: `pol_${l.id}`,
            qb_po_txn_line_id: `${l.id}-txnline`,
            variant_qb_item_list_id: `item-${l.sku}`,
          })),
        };
      }
      // The pipeline row insert reads its id back from RETURNING.
      if (q.includes("INSERT INTO") && q.includes("RETURNING")) {
        return { rows: [{ id: "qvb_1" }], rowCount: 1 };
      }
      // Everything the dependency chain asks for afterwards.
      return { rows: [], rowCount: 0 };
    }
  };

  // The dependency chain refuses to run without a transaction — it serialises
  // the PO's QB operations, so it must not half-write. It shares this handler
  // and `calls`, which is how the payload it inserts gets captured.
  const knex = {
    raw: handler,
    transaction: async () => ({
      raw: handler,
      commit: async () => {},
      rollback: async () => {},
    }),
  } as unknown as EnqueueKnex;

  /** The item lines inside whatever payload was handed to the pipeline. */
  const itemLinesSent = (): Array<{ sku: string; quantity: number }> => {
    for (const call of calls) {
      for (const binding of call.bindings) {
        if (typeof binding !== "string" || !binding.includes("item_lines")) {
          continue;
        }
        try {
          const parsed = JSON.parse(binding) as {
            item_lines?: Array<{ sku: string; quantity: number }>;
          };
          if (parsed.item_lines) return parsed.item_lines;
        } catch {
          // Not the payload — keep looking.
        }
      }
      const obj = call.bindings.find(
        (b): b is { item_lines?: Array<{ sku: string; quantity: number }> } =>
          typeof b === "object" && b !== null && "item_lines" in b
      );
      if (obj?.item_lines) return obj.item_lines;
    }
    return [];
  };

  return { knex, calls, itemLinesSent };
}

describe("QuickBooks payload — zero-quantity lines", () => {
  const previousMode = process.env.QB_VENDOR_BILL_MODE;
  beforeAll(() => {
    process.env.QB_VENDOR_BILL_MODE = "bill";
  });
  afterAll(() => {
    process.env.QB_VENDOR_BILL_MODE = previousMode;
  });

  it("sends only the lines the invoice actually covers", async () => {
    // The shape of VB-1076: seeded from a 5-line PO, three dropped to zero.
    const { knex, itemLinesSent } = fakeKnex([
      { id: "l1", sku: "ET2-E24618-BCN", qty: 1, unit_cost_cents: 170917 },
      { id: "l2", sku: "ET2-E25089-148BK", qty: 0, unit_cost_cents: 44917 },
      { id: "l3", sku: "ET2-E11096-10NAB", qty: 1, unit_cost_cents: 77400 },
      { id: "l4", sku: "ET2-E20497-MPLT", qty: 0, unit_cost_cents: 206917 },
      { id: "l5", sku: "ET2-E30318-BK", qty: 0, unit_cost_cents: 19267 },
    ]);
    await enqueueQbVendorBillAdd(knex, "vb_1");

    const sent = itemLinesSent();
    expect(sent.map((l) => l.sku)).toEqual([
      "ET2-E24618-BCN",
      "ET2-E11096-10NAB",
    ]);
    expect(sent.every((l) => Number(l.quantity) > 0)).toBe(true);
  });

  it("does not drop a line that carries quantity", async () => {
    const { knex, itemLinesSent } = fakeKnex([
      { id: "l1", sku: "A", qty: 1, unit_cost_cents: 100 },
      { id: "l2", sku: "B", qty: 6, unit_cost_cents: 200 },
    ]);
    await enqueueQbVendorBillAdd(knex, "vb_1");
    expect(itemLinesSent().map((l) => l.sku)).toEqual(["A", "B"]);
  });

  it("refuses the whole bill rather than send an empty document", async () => {
    // Every line at zero leaves nothing to bill. Sending a Bill made only of
    // Quantity-0 rows would post a $0 document to QuickBooks.
    const { knex } = fakeKnex([
      { id: "l1", sku: "A", qty: 0, unit_cost_cents: 100 },
      { id: "l2", sku: "B", qty: 0, unit_cost_cents: 200 },
    ]);
    const result = await enqueueQbVendorBillAdd(knex, "vb_1");
    expect(result).toEqual({ queued: false, reason: "bill has no lines to send" });
  });
});
