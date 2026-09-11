/**
 * po-link.ts — the vendor credit ↔ purchase order contract
 * (plan `vc-po-return-20260911`).
 *
 * A credit that returns goods names its PO; every product line names the PO
 * line it returns; and the units returned across ALL active credits (draft
 * + posted, not deleted, not voided) of a PO line can never exceed what was
 * actually RECEIVED on it (`purchase_order_line.qty_received`, the
 * denormalized sum over non-voided receipts).
 *
 * The pure part (`validateProductLinesAgainstPo`, `computeReturnable`) is
 * unit-tested with no DB; the loaders are thin `$n` queries over tables this
 * module only READS (`purchase_order*`, `vendor_bill*` — never written here).
 */

import { VendorCreditError, type PgClient, type VendorCreditLineInput } from "./types";

export interface PoLineRef {
  id: string;
  product_variant_id: string;
  inventory_item_id: string;
  sku_snapshot: string;
  description_snapshot: string;
  qty_received: number;
  unit_cost_cents: number;
}

export interface PoForCredit {
  id: string;
  number: string | null;
  status: string;
  vendor_id: string;
  stock_location_id: string;
  lines: Map<string, PoLineRef>;
}

interface PoRow {
  id: string;
  number: string | null;
  status: string;
  vendor_id: string;
  stock_location_id: string;
}

interface PoLineRow {
  id: string;
  product_variant_id: string;
  inventory_item_id: string;
  sku_snapshot: string;
  description_snapshot: string;
  qty_received: number | string;
  unit_cost_cents: number | string;
}

/** Header + lines of a PO, or null when it does not exist. Read-only. */
export async function loadPoForCredit(client: PgClient, poId: string): Promise<PoForCredit | null> {
  const { rows } = await client.query(
    `SELECT id, number, status, vendor_id, stock_location_id
       FROM purchase_order WHERE id = $1 AND deleted_at IS NULL`,
    [poId]
  );
  const po = rows[0] as PoRow | undefined;
  if (!po) return null;
  const { rows: lineRows } = await client.query(
    `SELECT id, product_variant_id, inventory_item_id, sku_snapshot, description_snapshot,
            qty_received, unit_cost_cents
       FROM purchase_order_line WHERE purchase_order_id = $1 AND deleted_at IS NULL
      ORDER BY line_order, id`,
    [poId]
  );
  const lines = new Map<string, PoLineRef>();
  for (const l of lineRows as PoLineRow[]) {
    lines.set(l.id, {
      id: l.id,
      product_variant_id: l.product_variant_id,
      inventory_item_id: l.inventory_item_id,
      sku_snapshot: l.sku_snapshot,
      description_snapshot: l.description_snapshot,
      qty_received: Number(l.qty_received ?? 0),
      unit_cost_cents: Number(l.unit_cost_cents ?? 0),
    });
  }
  return { ...po, lines };
}

/**
 * Units already claimed per PO line by OTHER active credits. `draft` counts
 * on purpose: two drafts must not both reserve the same received units —
 * the second save is refused, not the second post. Voided and soft-deleted
 * credits release their units.
 */
export async function loadCreditedQtyByPoLine(
  client: PgClient,
  poId: string,
  excludeCreditId: string | null
): Promise<Map<string, number>> {
  const { rows } = await client.query(
    `SELECT vcl.purchase_order_line_id AS po_line_id, COALESCE(SUM(vcl.qty), 0)::int AS qty
       FROM vendor_credit_line vcl
       JOIN vendor_credit vc ON vc.id = vcl.credit_id
      WHERE vc.purchase_order_id = $1
        AND vc.status IN ('draft', 'posted')
        AND vc.deleted_at IS NULL
        AND vcl.deleted_at IS NULL
        AND vcl.line_type = 'product'
        AND vcl.purchase_order_line_id IS NOT NULL
        AND ($2::text IS NULL OR vc.id <> $2::text)
      GROUP BY vcl.purchase_order_line_id`,
    [poId, excludeCreditId]
  );
  const out = new Map<string, number>();
  for (const r of rows as { po_line_id: string; qty: number }[]) out.set(r.po_line_id, Number(r.qty));
  return out;
}

export function computeReturnable(qtyReceived: number, qtyCredited: number): number {
  return Math.max(0, Math.floor(qtyReceived) - Math.floor(qtyCredited));
}

/** A credit with no PO cannot return goods — account lines only. */
export function assertNoProductLinesWithoutPo(lines: VendorCreditLineInput[]): void {
  if (lines.some((l) => l.line_type === "product")) {
    throw new VendorCreditError(
      "product_line_requires_po",
      "Product lines need a purchase order: link the credit to the PO the items came from."
    );
  }
}

/**
 * PURE. Every product line must name a PO line of THIS PO with received
 * units, carry an integer qty ≥ 1, and the request's Σqty per PO line plus
 * what other active credits already claim must fit in `qty_received`.
 * Returns the lines with `variant_id`/`sku`/`description` defaulted from the
 * PO line snapshot where the caller left them empty (never overrides a
 * value the caller sent, except a variant that contradicts the PO line).
 */
export function validateProductLinesAgainstPo(
  lines: VendorCreditLineInput[],
  po: PoForCredit,
  creditedByPoLine: Map<string, number>
): VendorCreditLineInput[] {
  const requested = new Map<string, number>();
  const out: VendorCreditLineInput[] = [];
  for (const line of lines) {
    if (line.line_type !== "product") {
      out.push(line);
      continue;
    }
    const poLineId = line.purchase_order_line_id ?? null;
    if (!poLineId) {
      throw new VendorCreditError(
        "po_line_required",
        "Every returned item must name the PO line it comes from."
      );
    }
    const poLine = po.lines.get(poLineId);
    if (!poLine) {
      throw new VendorCreditError(
        "po_line_not_in_po",
        `PO line ${poLineId} does not belong to ${po.number ?? po.id}.`
      );
    }
    if (line.variant_id && line.variant_id !== poLine.product_variant_id) {
      throw new VendorCreditError(
        "variant_mismatch",
        `Line ${poLine.sku_snapshot}: variant does not match the PO line.`
      );
    }
    const qty = Number(line.qty);
    if (!Number.isInteger(qty) || qty < 1) {
      throw new VendorCreditError(
        "invalid_qty",
        `Line ${poLine.sku_snapshot}: qty must be a whole number ≥ 1.`
      );
    }
    if (poLine.qty_received <= 0) {
      throw new VendorCreditError(
        "po_line_not_received",
        `Line ${poLine.sku_snapshot}: nothing has been received on this PO line yet.`
      );
    }
    const soFar = (requested.get(poLineId) ?? 0) + qty;
    requested.set(poLineId, soFar);
    const returnable = computeReturnable(poLine.qty_received, creditedByPoLine.get(poLineId) ?? 0);
    if (soFar > returnable) {
      throw new VendorCreditError(
        "exceeds_returnable",
        `Line ${poLine.sku_snapshot}: only ${returnable} of ${poLine.qty_received} received unit${poLine.qty_received === 1 ? "" : "s"} can still be returned (requested ${soFar}).`
      );
    }
    out.push({
      ...line,
      variant_id: poLine.product_variant_id,
      sku: line.sku ?? poLine.sku_snapshot,
      description: line.description ?? poLine.description_snapshot,
    });
  }
  return out;
}

export interface RegularBillForPo {
  id: string;
  number: string | null;
  status: string;
  reference_id: string | null;
}

/** Regular (goods) bills of a PO that a credit can name — confirmed or synced. */
export async function loadRegularBillsForPo(
  client: PgClient,
  poId: string
): Promise<RegularBillForPo[]> {
  const { rows } = await client.query(
    `SELECT id, number, status, reference_id
       FROM vendor_bill
      WHERE purchase_order_id = $1 AND bill_type = 'regular'
        AND status IN ('confirmed', 'synced') AND deleted_at IS NULL
      ORDER BY confirmed_at DESC NULLS LAST, created_at DESC`,
    [poId]
  );
  return rows as RegularBillForPo[];
}

/** The bill a credit names must be one of `loadRegularBillsForPo(po)`. */
export async function assertBillBelongsToPo(
  client: PgClient,
  billId: string,
  poId: string
): Promise<void> {
  const bills = await loadRegularBillsForPo(client, poId);
  if (!bills.some((b) => b.id === billId)) {
    throw new VendorCreditError(
      "bill_not_on_po",
      "The related bill must be a confirmed regular bill of the credit's purchase order."
    );
  }
}

/**
 * Resolves and checks the PO a credit is being linked to: exists, belongs
 * to the credit's vendor, and has received units somewhere.
 */
export async function loadAndAssertPoForVendor(
  client: PgClient,
  poId: string,
  vendorId: string
): Promise<PoForCredit> {
  const po = await loadPoForCredit(client, poId);
  if (!po) throw new VendorCreditError("po_not_found", "Purchase order not found.", 404);
  if (po.vendor_id !== vendorId) {
    throw new VendorCreditError(
      "po_vendor_mismatch",
      "The purchase order belongs to a different vendor."
    );
  }
  if (![...po.lines.values()].some((l) => l.qty_received > 0)) {
    throw new VendorCreditError(
      "po_nothing_received",
      `${po.number ?? po.id} has no received units — nothing can be returned from it.`
    );
  }
  return po;
}
