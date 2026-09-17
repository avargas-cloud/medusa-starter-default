/**
 * GET /admin/commissions/requests?status=pending|approved|rejected — bandeja de
 * Accounting (pestaña Pending de /accounting/commissions). Sólo Accounting:
 * la lista cruza órdenes de toda la tienda (commission-requests-20260917).
 */

import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { getDbPool } from "../../../utils/db-pool";
import {
  listRequestsByStatus,
  serializeRequest,
  type CommissionRequestStatus,
} from "../../../../lib/commissions/requests";
import { assertAccounting } from "../_lib/guard";

const STATUSES: ReadonlySet<string> = new Set(["pending", "approved", "rejected"]);

export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse): Promise<void> {
  if (!(await assertAccounting(req, res))) return;
  const raw = typeof req.query.status === "string" ? req.query.status : "pending";
  if (!STATUSES.has(raw)) {
    res.status(400).json({ error: "status must be pending, approved or rejected." });
    return;
  }
  const status = raw as CommissionRequestStatus;
  try {
    const rows = await listRequestsByStatus(getDbPool(), status);
    res.json({ status, count: rows.length, requests: rows.map(serializeRequest) });
  } catch (err) {
    console.error("[commission-requests] GET list failed:", err);
    res.status(500).json({ error: "Could not load the commission requests." });
  }
}
