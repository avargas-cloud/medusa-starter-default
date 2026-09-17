import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { countUnread, markRead } from "../../../../../../lib/notifications/inbox";
import { getDbPool } from "../../../../../utils/db-pool";

/**
 * PATCH /admin/pos/notifications/:id/read
 *
 * Marca leída UNA notificación del actor. Si el id no es suyo contesta 404 —
 * no 403 — para no confirmar que el id existe.
 */
export async function PATCH(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const userId = req.auth_context?.actor_id;
  if (!userId) {
    res.status(401).json({ error: "POS_AUTH_REQUIRED" });
    return;
  }
  const notificationId = String(req.params.id ?? "");
  if (!notificationId.startsWith("posn_")) {
    res.status(400).json({ error: "INVALID_NOTIFICATION_ID" });
    return;
  }
  try {
    const db = getDbPool();
    const ok = await markRead(db, userId, notificationId);
    if (!ok) {
      res.status(404).json({ error: "NOTIFICATION_NOT_FOUND" });
      return;
    }
    res.json({ ok: true, unread_count: await countUnread(db, userId) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[pos-notifications] PATCH read failed: ${message}`);
    res.status(500).json({ error: "NOTIFICATION_READ_FAILED" });
  }
}
