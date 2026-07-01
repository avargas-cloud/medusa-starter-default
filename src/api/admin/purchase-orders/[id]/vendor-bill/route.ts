/**
 * POST /admin/purchase-orders/:id/vendor-bill  — RETIRED (Option A)
 *
 * This route used to mint ONE regular vendor bill spanning every unbilled
 * receipt line of a purchase order. Under Option A (one regular bill per
 * receipt/shipment — see docs/VENDOR_BILL_REGULAR_IMPROVEMENTS_PLAN.md) that
 * model is wrong: each shipment must get its own bill so per-shipment confirm,
 * AVCO, and freight/service/tariff stay consistent.
 *
 * Create per-receipt bills via
 *   POST /admin/purchase-orders/:id/receipts/:receiptId/vendor-bill
 * (the "Item receipt" path in the New Vendor Bill modal), or a PO-ordered
 * planning bill via POST /admin/vendor-bills + fill-from-po.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

export async function POST(
  _req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  return res.status(409).json({
    error:
      "Creating one bill for a whole purchase order is retired. Create a vendor bill per receipt (shipment) instead.",
    code: "po_level_bill_retired",
  });
}
