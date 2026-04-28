/**
 * GET /admin/factory-orders/receipts
 * Cross-FO receipt list. Returns all receipts with embedded FO metadata.
 *
 * Query params: limit, offset, status, fo_id, date_from, date_to
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { getActorUserId } from "../_lib/auth";
import { listReceiptsCrossFo } from "../_lib/receipts-query";
import { getFactoryOrdersService } from "../_lib/service-resolver";

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<void> {
  getActorUserId(req);

  const service = getFactoryOrdersService(req);
  const q = req.query as Record<string, string | undefined>;

  const result = await listReceiptsCrossFo(service, {
    limit: Math.min(Number(q.limit ?? 50), 200),
    offset: Number(q.offset ?? 0),
    status: q.status,
    fo_id: q.fo_id,
    date_from: q.date_from,
    date_to: q.date_to,
  });

  res.json(result);
}
