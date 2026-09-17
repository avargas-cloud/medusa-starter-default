import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { markAllRead } from "../../../../../lib/notifications/inbox";
import { getDbPool } from "../../../../utils/db-pool";

/** POST /admin/pos/notifications/read-all — "Mark all read" del actor. */
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const userId = req.auth_context?.actor_id;
  if (!userId) {
    res.status(401).json({ error: "POS_AUTH_REQUIRED" });
    return;
  }
  try {
    const marked = await markAllRead(getDbPool(), userId);
    res.json({ ok: true, marked, unread_count: 0 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[pos-notifications] POST read-all failed: ${message}`);
    res.status(500).json({ error: "NOTIFICATIONS_READ_ALL_FAILED" });
  }
}
