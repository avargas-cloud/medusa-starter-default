import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { clampLimit, countUnread, listInbox } from "../../../../lib/notifications/inbox";
import { getDbPool } from "../../../utils/db-pool";

/**
 * GET /admin/pos/notifications?unread=1&limit=30
 *
 * La bandeja de la campana. El destinatario es SIEMPRE el actor del JWT: no
 * existe `?user_id=` — un cajero no puede leer los pagos de otro rep. La
 * respuesta trae también `unread_count` para que el badge no necesite otra
 * request.
 */
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const userId = req.auth_context?.actor_id;
  if (!userId) {
    res.status(401).json({ error: "POS_AUTH_REQUIRED" });
    return;
  }
  const query = req.query as Record<string, unknown>;
  const unreadOnly = query.unread === "1" || query.unread === "true";
  const limit = clampLimit(query.limit);
  try {
    const db = getDbPool();
    const [notifications, unread_count] = await Promise.all([
      listInbox(db, { user_id: userId, unread_only: unreadOnly, limit }),
      countUnread(db, userId),
    ]);
    res.json({ notifications, unread_count, limit });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[pos-notifications] GET failed: ${message}`);
    res.status(500).json({ error: "NOTIFICATIONS_LIST_FAILED" });
  }
}
