/**
 * DELETE /admin/commissions/orders/:orderId/requests/:requestId — retirar una
 * solicitud PENDIENTE. Puede su autor (el cajero que la creó) o Accounting.
 * Soft-delete: la traza queda (commission-requests-20260917).
 */

import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { getDbPool } from "../../../../../../utils/db-pool";
import { withOrderCommissionLock } from "../../../../../../../lib/commissions/writer";
import {
  CommissionRequestError,
  requestErrorStatus,
  withdrawRequest,
} from "../../../../../../../lib/commissions/requests";
import { canViewAccounting } from "../../../../../trip-objectives/_lib/guard";

export async function DELETE(req: AuthenticatedMedusaRequest, res: MedusaResponse): Promise<void> {
  const { orderId, requestId } = req.params;
  if (!orderId || !requestId) {
    res.status(400).json({ error: "orderId and requestId are required." });
    return;
  }
  const actorId = req.auth_context?.actor_id ?? null;
  if (!actorId) {
    res.status(401).json({ error: "Unauthorized." });
    return;
  }
  const canAccounting = await canViewAccounting(req);
  try {
    await withOrderCommissionLock(getDbPool(), orderId, async (client) => {
      // La solicitud tiene que ser de ESTA orden: el id de la URL no es decorativo.
      const { rowCount } = await client.query(
        `SELECT 1 FROM commission_request WHERE id = $1 AND order_id = $2 AND deleted_at IS NULL`,
        [requestId, orderId]
      );
      if (!rowCount) throw new CommissionRequestError("not_found", "Request not found.");
      await withdrawRequest(client, requestId, { actorId, canAccounting });
    });
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof CommissionRequestError) {
      res.status(requestErrorStatus(err)).json({ error: err.message, code: err.code });
      return;
    }
    console.error("[commission-requests] DELETE failed:", err);
    res.status(500).json({ error: "Could not withdraw the commission request." });
  }
}
