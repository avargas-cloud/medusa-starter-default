import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { getDbPool } from "../../../../utils/db-pool";
import {
  FullAdminRequiredError,
  requireFullAdmin,
} from "../../../../../lib/accounting/month-close-auth";
import {
  computeReturnable,
  loadCreditedQtyByPoLine,
  loadPoForCredit,
  loadRegularBillsForPo,
} from "../../../../../lib/vendor-credits";

interface BillCostRow {
  purchase_order_line_id: string;
  unit_cost_cents: number | string;
}

/**
 * GET /admin/vendor-credits/po-returnable/:poId?exclude_credit_id=
 *
 * What a vendor credit may return from this PO: each PO line with its
 * received units, the units OTHER active credits already claim (the
 * `exclude_credit_id` — the credit being edited — is left out so the
 * detail page can add its own lines back on top), and the unit cost the
 * vendor actually invoiced (the regular bill's line cost when one exists,
 * the PO line cost otherwise). Plus the PO's confirmed regular bills, the
 * candidates for "related bill". Read-only over tables this module never
 * writes.
 */
export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  try {
    await requireFullAdmin(req);
  } catch (error) {
    if (error instanceof FullAdminRequiredError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    throw error;
  }

  const { poId } = req.params as { poId: string };
  const { exclude_credit_id } = req.query as { exclude_credit_id?: string };
  const pool = getDbPool();

  const po = await loadPoForCredit(pool, poId);
  if (!po) {
    return res.status(404).json({ error: "Purchase order not found.", code: "po_not_found" });
  }
  const [credited, bills, billCostRows, mpnRows] = await Promise.all([
    loadCreditedQtyByPoLine(pool, poId, exclude_credit_id || null),
    loadRegularBillsForPo(pool, poId),
    pool.query(
      // Latest confirmed/synced regular bill line per PO line — the price the
      // vendor actually charged, which is what a credit for a return refunds.
      `SELECT DISTINCT ON (vbl.purchase_order_line_id)
              vbl.purchase_order_line_id, vbl.unit_cost_cents
         FROM vendor_bill_line vbl
         JOIN vendor_bill vb ON vb.id = vbl.vendor_bill_id
        WHERE vb.purchase_order_id = $1 AND vb.bill_type = 'regular'
          AND vb.status IN ('confirmed', 'synced') AND vb.deleted_at IS NULL
          AND vbl.deleted_at IS NULL AND vbl.line_type = 'product'
          AND vbl.purchase_order_line_id IS NOT NULL
        ORDER BY vbl.purchase_order_line_id, vb.confirmed_at DESC NULLS LAST, vb.created_at DESC`,
      [poId]
    ),
    pool.query(
      `SELECT id, metadata ->> 'mpn' AS mpn FROM product_variant
        WHERE id = ANY($1::text[]) AND deleted_at IS NULL`,
      [[...po.lines.values()].map((l) => l.product_variant_id)]
    ),
  ]);
  const billCostByPoLine = new Map<string, number>();
  for (const r of billCostRows.rows as BillCostRow[]) {
    billCostByPoLine.set(r.purchase_order_line_id, Number(r.unit_cost_cents));
  }
  const mpnByVariant = new Map<string, string | null>();
  for (const r of mpnRows.rows as { id: string; mpn: string | null }[]) mpnByVariant.set(r.id, r.mpn);

  const lines = [...po.lines.values()].map((l) => {
    const qtyCredited = credited.get(l.id) ?? 0;
    const billCost = billCostByPoLine.get(l.id) ?? null;
    return {
      purchase_order_line_id: l.id,
      product_variant_id: l.product_variant_id,
      inventory_item_id: l.inventory_item_id,
      sku: l.sku_snapshot,
      mpn: mpnByVariant.get(l.product_variant_id) ?? null,
      description: l.description_snapshot,
      qty_received: l.qty_received,
      qty_credited: qtyCredited,
      qty_returnable: computeReturnable(l.qty_received, qtyCredited),
      po_unit_cost_cents: l.unit_cost_cents,
      bill_unit_cost_cents: billCost,
      unit_cost_cents: billCost ?? l.unit_cost_cents,
    };
  });

  return res.json({
    purchase_order: {
      id: po.id,
      number: po.number,
      status: po.status,
      vendor_id: po.vendor_id,
      stock_location_id: po.stock_location_id,
    },
    lines,
    bills,
  });
}
