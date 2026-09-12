import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { isQbSyncEnabled } from "../../../../lib/quickbooks/sync-enabled";

/**
 * GET /admin/pos/runtime-config
 *
 * Read-only flags the POS uses to decide what to show — every authenticated
 * admin can read this (no PIN, no owner-only gate: these are feature
 * switches, not secrets). Answers booleans/strings only, never a credential.
 *
 * `qb_sync_enabled` lets the POS hide QuickBooks-specific UI (pipeline
 * status widgets, "Sync to QuickBooks" actions) while an operator has
 * QB_SYNC_ENABLED=false.
 */
export const GET = async (_req: MedusaRequest, res: MedusaResponse) => {
  res.json({
    qb_sync_enabled: isQbSyncEnabled(),
    gl_posting_enabled: process.env.GL_POSTING_ENABLED === "true",
    banking_enabled: process.env.BANKING_ENABLED === "true",
    ecopowertech_env: process.env.ECOPOWERTECH_ENV ?? "production",
  });
};
