import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ContainerRegistrationKeys } from "@medusajs/utils";

import { QUICKBOOKS_CATALOG_MODULE } from "../../../../../modules/quickbooks-catalog";

const ACTIVE_STATUSES = ["queued", "fetching", "processing"] as const;

/**
 * POST /admin/qb-catalog/vendors/sync-payment-terms
 *
 * Pull every vendor's payment term from QuickBooks and stamp the resolved
 * due-days on `qb_vendor.metadata.default_payment_terms_days` — the number a
 * vendor bill's Due Date is computed from.
 *
 * Runs on the same durable machinery as the full vendor sync
 * (`qb_vendor_sync_run` + the qb-vendor-sync-runner cron) with `mode`
 * = 'payment_terms', so it survives a backend restart and reports progress.
 * Returns 202 immediately; poll `GET /admin/qb-catalog/vendors/sync`.
 *
 * Terms-only differs from the full sync in what it WRITES (the term + its
 * days, never the vendor's address/email/etc.), not in what it reads: both
 * need the same QB VendorQuery, so it is not a cheaper QB round trip.
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const catalog = req.scope.resolve(QUICKBOOKS_CATALOG_MODULE) as any;
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY);

  // One vendor pull at a time, whatever its mode — two concurrent runs would
  // fight over the same rows and double the QB round trips.
  const activeRuns = await Promise.all(
    ACTIVE_STATUSES.map(async (s) => {
      const { data } = await query.graph({
        entity: "qb_vendor_sync_run",
        fields: ["id", "status", "mode"],
        filters: { status: s } as any,
        pagination: { skip: 0, take: 1 },
      });
      return (data as { id: string; mode: string | null }[])[0];
    })
  );
  const existingActive = activeRuns.find(Boolean);
  if (existingActive) {
    return res.status(409).json({
      error: "A vendor sync is already in flight",
      run_id: existingActive.id,
      mode: existingActive.mode ?? "full",
    });
  }

  const userId = (req as any).auth_context?.actor_id ?? null;

  const run = await catalog.createQbVendorSyncRuns({
    status: "queued",
    mode: "payment_terms",
    triggered_by_user_id: userId,
  });

  return res.status(202).json({
    success: true,
    run_id: run.id,
    status: run.status,
    mode: "payment_terms",
    message:
      "Payment terms resync enqueued. Runner will pick it up within ~1 min.",
  });
};
