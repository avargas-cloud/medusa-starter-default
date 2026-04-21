import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ContainerRegistrationKeys } from "@medusajs/utils";

import { QUICKBOOKS_CATALOG_MODULE } from "../../../../../../modules/quickbooks-catalog";

const CANCELLABLE = new Set(["queued", "fetching", "processing"]);

/**
 * GET /admin/qb-catalog/vendors/sync/:id
 * Return a specific run by id — used by the UI to poll progress.
 */
export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY);
  const id = req.params.id;

  const { data } = await query.graph({
    entity: "qb_vendor_sync_run",
    fields: [
      "id",
      "status",
      "total_count",
      "processed_count",
      "created_count",
      "updated_count",
      "error_count",
      "started_at",
      "completed_at",
      "last_error",
      "triggered_by_user_id",
      "created_at",
      "updated_at",
    ],
    filters: { id },
    pagination: { skip: 0, take: 1 },
  });

  const run = (data as any[])[0];
  if (!run) return res.status(404).json({ error: "Sync run not found" });
  return res.json({ run });
};

/**
 * DELETE /admin/qb-catalog/vendors/sync/:id
 * Cancel an in-flight sync. No effect if the run is already terminal.
 */
export const DELETE = async (req: MedusaRequest, res: MedusaResponse) => {
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY);
  const catalog = req.scope.resolve(QUICKBOOKS_CATALOG_MODULE) as any;
  const id = req.params.id;

  const { data } = await query.graph({
    entity: "qb_vendor_sync_run",
    fields: ["id", "status"],
    filters: { id },
    pagination: { skip: 0, take: 1 },
  });
  const run = (data as { id: string; status: string }[])[0];
  if (!run) return res.status(404).json({ error: "Sync run not found" });

  if (!CANCELLABLE.has(run.status)) {
    return res.status(400).json({
      error: `Run is already ${run.status} — cannot cancel`,
    });
  }

  await catalog.updateQbVendorSyncRuns({
    id: run.id,
    status: "cancelled",
    completed_at: new Date(),
    vendor_snapshot: null,
  });

  return res.json({ success: true });
};
