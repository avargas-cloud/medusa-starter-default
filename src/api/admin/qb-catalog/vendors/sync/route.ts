import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ContainerRegistrationKeys } from "@medusajs/utils";

import { QUICKBOOKS_CATALOG_MODULE } from "../../../../../modules/quickbooks-catalog";

const ACTIVE_STATUSES = ["queued", "fetching", "processing"] as const;

/**
 * POST /admin/qb-catalog/vendors/sync
 * Enqueue a fire-and-forget vendor sync. Returns 202 with { run_id } when queued.
 * Returns 409 if a run is already in flight.
 *
 * The actual work is performed by the qb-vendor-sync-runner cron job (every 30s),
 * so this endpoint returns in <100 ms and survives server restarts.
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const catalog = req.scope.resolve(QUICKBOOKS_CATALOG_MODULE) as any;
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY);

  // Reject if a run is already in flight (one-at-a-time policy).
  const activeCounts = await Promise.all(
    ACTIVE_STATUSES.map(async (s) => {
      const { data } = await query.graph({
        entity: "qb_vendor_sync_run",
        fields: ["id", "status"],
        filters: { status: s } as any,
        pagination: { skip: 0, take: 1 },
      });
      return (data as { id: string }[])[0];
    })
  );
  const existingActive = activeCounts.find(Boolean);
  if (existingActive) {
    return res.status(409).json({
      error: "A vendor sync is already in flight",
      run_id: existingActive.id,
    });
  }

  const userId = (req as any).auth_context?.actor_id ?? null;

  const run = await catalog.createQbVendorSyncRuns({
    status: "queued",
    triggered_by_user_id: userId,
  });

  return res.status(202).json({
    success: true,
    run_id: run.id,
    status: run.status,
    message: "Vendor sync enqueued. Runner will pick it up within ~30s.",
  });
};

/**
 * GET /admin/qb-catalog/vendors/sync
 * Return the latest sync run (regardless of status). Used by the admin UI
 * to surface progress after a page reload.
 */
export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY);

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
    pagination: { skip: 0, take: 20 },
  });

  const all = data as any[];
  const sorted = all.sort((a, b) => {
    const ta = new Date(a.created_at ?? 0).getTime();
    const tb = new Date(b.created_at ?? 0).getTime();
    return tb - ta;
  });

  return res.json({ run: sorted[0] ?? null });
};
