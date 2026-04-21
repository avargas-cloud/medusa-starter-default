/**
 * src/api/admin/qb-catalog/vendors/[id]/sync-meili/route.ts
 *
 * POST /admin/qb-catalog/vendors/:id/sync-meili — re-index a single
 * vendor row into Meili. Intended for per-row "Force Resync" buttons
 * in the admin UI and as a fallback when bulk sync misses a row.
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { updateSingleVendorMeiliWorkflow } from "../../../../../../workflows/update-single-vendor-meili";

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const { id } = req.params as { id: string };
  if (!id) {
    return res.status(400).json({ ok: false, error: "vendor id required" });
  }

  try {
    const { result } = await updateSingleVendorMeiliWorkflow(req.scope).run({
      input: { vendor_id: id },
    });
    return res.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Sync failed";
    return res.status(500).json({ ok: false, error: message });
  }
}
