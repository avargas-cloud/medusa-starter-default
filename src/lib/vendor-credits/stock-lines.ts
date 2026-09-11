import type { PgClient } from "./types";

/**
 * What a vendor credit's stock movement consists of (plan
 * `vc-po-return-20260911`): one delta per product line, at the linked PO's
 * location, keyed by the PO line's `inventory_item_id`. Read-only over
 * `purchase_order*`; the movement itself runs through the Inventory module
 * (`workflows/vendor-credits/adjust-vendor-credit-stock.ts`), never SQL on
 * `inventory_level`.
 */
export interface VendorCreditStockLine {
  credit_line_id: string;
  purchase_order_line_id: string;
  inventory_item_id: string;
  sku: string | null;
  qty: number;
}

export interface VendorCreditStockState {
  id: string;
  status: string;
  purchase_order_id: string | null;
  stock_location_id: string | null;
  stock_applied_at: string | null;
  stock_reversed_at: string | null;
  lines: VendorCreditStockLine[];
}

interface HeaderRow {
  id: string;
  status: string;
  purchase_order_id: string | null;
  stock_location_id: string | null;
  stock_applied_at: string | Date | null;
  stock_reversed_at: string | Date | null;
}

interface LineRow {
  credit_line_id: string;
  purchase_order_line_id: string;
  inventory_item_id: string;
  sku: string | null;
  qty: number | string;
}

const iso = (v: string | Date | null): string | null =>
  v == null ? null : v instanceof Date ? v.toISOString() : String(v);

export async function loadVendorCreditStockState(
  client: PgClient,
  creditId: string
): Promise<VendorCreditStockState | null> {
  const { rows } = await client.query(
    `SELECT vc.id, vc.status, vc.purchase_order_id, po.stock_location_id,
            vc.stock_applied_at, vc.stock_reversed_at
       FROM vendor_credit vc
       LEFT JOIN purchase_order po ON po.id = vc.purchase_order_id AND po.deleted_at IS NULL
      WHERE vc.id = $1 AND vc.deleted_at IS NULL`,
    [creditId]
  );
  const header = rows[0] as HeaderRow | undefined;
  if (!header) return null;
  const { rows: lineRows } = await client.query(
    `SELECT vcl.id AS credit_line_id, vcl.purchase_order_line_id, pol.inventory_item_id, vcl.sku, vcl.qty
       FROM vendor_credit_line vcl
       JOIN purchase_order_line pol ON pol.id = vcl.purchase_order_line_id
      WHERE vcl.credit_id = $1 AND vcl.deleted_at IS NULL
        AND vcl.line_type = 'product' AND vcl.qty > 0
      ORDER BY vcl.sort`,
    [creditId]
  );
  return {
    id: header.id,
    status: header.status,
    purchase_order_id: header.purchase_order_id,
    stock_location_id: header.stock_location_id,
    stock_applied_at: iso(header.stock_applied_at),
    stock_reversed_at: iso(header.stock_reversed_at),
    lines: (lineRows as LineRow[]).map((l) => ({
      credit_line_id: l.credit_line_id,
      purchase_order_line_id: l.purchase_order_line_id,
      inventory_item_id: l.inventory_item_id,
      sku: l.sku,
      qty: Number(l.qty),
    })),
  };
}

export type StockDirection = "apply" | "reverse";

export type StockDecision =
  | { run: true; direction: StockDirection; location_id: string; lines: VendorCreditStockLine[] }
  | { run: false; reason: string };

/**
 * PURE. Whether the movement should run, given the credit's state. `apply`
 * needs a posted credit with a PO, product lines, and no prior apply;
 * `reverse` needs a prior apply with no prior reverse. Everything else is a
 * documented no-op — never an error, so post/void never fail on stock.
 */
export function decideStockMovement(
  state: VendorCreditStockState,
  direction: StockDirection
): StockDecision {
  if (!state.purchase_order_id) return { run: false, reason: "credit has no purchase order" };
  if (!state.stock_location_id) return { run: false, reason: "purchase order has no stock location" };
  if (state.lines.length === 0) return { run: false, reason: "credit has no product lines" };
  if (direction === "apply") {
    if (state.status !== "posted") return { run: false, reason: `credit is ${state.status}, expected posted` };
    if (state.stock_applied_at) return { run: false, reason: `stock already applied at ${state.stock_applied_at}` };
  } else {
    if (!state.stock_applied_at) return { run: false, reason: "stock was never applied" };
    if (state.stock_reversed_at) return { run: false, reason: `stock already reversed at ${state.stock_reversed_at}` };
  }
  return { run: true, direction, location_id: state.stock_location_id, lines: state.lines };
}
