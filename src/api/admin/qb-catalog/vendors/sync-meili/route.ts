/**
 * src/api/admin/qb-catalog/vendors/sync-meili/route.ts
 *
 * POST /admin/qb-catalog/vendors/sync-meili — re-index every qb_vendor
 * row into the Meilisearch `vendors` index. Used by the admin backend
 * UI button and by manual repair flows when the index drifts from DB.
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { syncVendorsToMeiliWorkflow } from "../../../../../workflows/sync-vendors-meilisearch";

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  try {
    const { result } = await syncVendorsToMeiliWorkflow(req.scope).run();
    return res.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Sync failed";
    return res.status(500).json({ ok: false, error: message });
  }
}
