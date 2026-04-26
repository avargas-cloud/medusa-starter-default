/**
 * GET /admin/purchase-orders/receipts
 *
 * Cross-PO receipt list for the standalone Receive Items module.
 * Returns all receipts (across all POs) with embedded PO metadata so
 * the frontend never has to join client-side.
 *
 * Query params:
 *   limit      (default 50, max 200)
 *   offset     (default 0)
 *   status     receipt status: pending | applied | synced | voided | error
 *   po_id      filter to a single PO
 *   date_from  ISO date string (inclusive)
 *   date_to    ISO date string (inclusive, end of day)
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { getActorUserId } from "../_lib/auth";
import { listReceiptsCrossPo } from "../_lib/receipts-query";
import { getPurchaseOrdersService } from "../_lib/service-resolver";

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<void> {
  getActorUserId(req); // ensures authenticated (admin or pos_user)

  const service = getPurchaseOrdersService(req);

  const q = req.query as Record<string, string | undefined>;
  const limit = Math.min(Number(q.limit ?? 50), 200);
  const offset = Number(q.offset ?? 0);

  const result = await listReceiptsCrossPo(service, {
    limit,
    offset,
    status: q.status,
    po_id: q.po_id,
    date_from: q.date_from,
    date_to: q.date_to,
  });

  res.json(result);
}
