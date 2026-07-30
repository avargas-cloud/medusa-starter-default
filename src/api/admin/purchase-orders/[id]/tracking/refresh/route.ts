/**
 * src/api/admin/purchase-orders/[id]/tracking/refresh/route.ts
 *
 * POST /admin/purchase-orders/:id/tracking/refresh
 *
 * Re-fetches the carrier ETA for every non-delivered tracking entry on the PO,
 * persists the enriched entries, and fills Expected Delivery only if it is
 * currently empty (a staff-entered date is never overwritten here). Returns the
 * updated tracking[] and expected_at.
 *
 * Called by the POS tracking modal after add/edit and on demand. The same
 * routine runs on a cron (jobs/refresh-po-tracking-eta.ts) for in-transit POs.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { getActorUserId, UnauthenticatedError } from "../../../_lib/auth";
import { getPurchaseOrdersService } from "../../../_lib/service-resolver";
import { refreshPoTrackingEta } from "../../../../../../lib/carrier-tracking/refresh-po";
import {
  resolvePoShipments,
  trackingCoverage,
} from "../../../../../../lib/purchase-orders/po-tracking-read";

interface PoHeaderLike {
  id: string;
  status: string;
  expected_at: Date | string | null;
}

type Knex = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
};

const FROZEN_STATUSES = ["cancelled", "voided"];

export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  try {
    getActorUserId(req);
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      return res
        .status(err.status)
        .json({ error: err.message, code: err.code });
    }
    throw err;
  }

  const { id } = req.params as { id: string };
  const service = getPurchaseOrdersService(req);

  const existing = (await service
    .retrievePurchaseOrder(id)
    .catch(() => null)) as unknown as PoHeaderLike | null;

  if (!existing) {
    return res
      .status(404)
      .json({ error: "Purchase order not found", code: "not_found" });
  }
  if (FROZEN_STATUSES.includes(existing.status)) {
    return res.status(409).json({
      error: `Cannot refresh tracking on a PO in status '${existing.status}'.`,
      code: "not_editable",
    });
  }

  const forceApply =
    (req.body as { apply?: boolean } | undefined)?.apply === true;
  const db = (
    req.scope as unknown as { resolve: (k: string) => Knex }
  ).resolve("__pg_connection__");

  const result = await refreshPoTrackingEta(db, service, existing, forceApply);

  // Re-read the full view so the caller gets the allocations too — the refresh
  // only touches carrier fields, but the modal redraws the whole list from this
  // response and would otherwise lose what each shipment carries.
  const tracking = await resolvePoShipments(db, id);

  return res.json({
    tracking,
    coverage: trackingCoverage(tracking),
    expected_at: result.expected_at,
    changed: result.changed,
  });
}
