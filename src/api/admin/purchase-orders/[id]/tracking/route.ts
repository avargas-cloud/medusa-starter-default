/**
 * src/api/admin/purchase-orders/[id]/tracking/route.ts
 *
 * POST   /admin/purchase-orders/:id/tracking  — append a tracking entry
 * PUT    /admin/purchase-orders/:id/tracking  — edit a tracking entry by id
 * DELETE /admin/purchase-orders/:id/tracking  — remove a tracking entry by id
 *
 * Tracking is inbound logistics for the PO (shipment FROM the vendor). It is
 * local-only and never synced to QuickBooks, so it lives in its own column +
 * route instead of the QB-aware PATCH on the parent resource.
 *
 * Editable while the PO is non-terminal (draft / submitted / partially_received
 * / received). Cancelled and voided POs are frozen.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { getActorUserId, UnauthenticatedError } from "../../_lib/auth";
import { zodErrorToBody } from "../../_lib/format";
import { getPurchaseOrdersService } from "../../_lib/service-resolver";
import {
  addTrackingSchema,
  deleteTrackingSchema,
  updateTrackingSchema,
} from "../../_lib/validators";
import type { TrackingEntry } from "../../../../../lib/carrier-tracking/types";
import {
  PO_STATUS_AUTOSHIP_BLOCKED_LIFECYCLE,
  PO_STATUS_SHIPPED_WAITING,
} from "../../_lib/po-shipping-status";

interface PoHeaderLike {
  id: string;
  status: string;
  po_status: string | null;
  tracking: TrackingEntry[] | null;
}

const FROZEN_STATUSES = ["cancelled", "voided"];

function parseTracking(raw: unknown): TrackingEntry[] {
  return Array.isArray(raw) ? (raw as TrackingEntry[]) : [];
}

async function loadPo(
  service: ReturnType<typeof getPurchaseOrdersService>,
  id: string
): Promise<PoHeaderLike | null> {
  return (await service
    .retrievePurchaseOrder(id)
    .catch(() => null)) as unknown as PoHeaderLike | null;
}

function newTrackingId(): string {
  return `potrk_${Date.now().toString(36)}${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

async function persistTracking(
  service: ReturnType<typeof getPurchaseOrdersService>,
  id: string,
  tracking: TrackingEntry[]
): Promise<TrackingEntry[]> {
  const update: Record<string, unknown> = { id, tracking };
  await service.updatePurchaseOrders([update]);
  return tracking;
}

export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  let userId: string;
  try {
    userId = getActorUserId(req);
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      return res
        .status(err.status)
        .json({ error: err.message, code: err.code });
    }
    throw err;
  }

  const { id } = req.params as { id: string };
  const parsed = addTrackingSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(zodErrorToBody(parsed.error));
  }

  const service = getPurchaseOrdersService(req);
  const existing = await loadPo(service, id);
  if (!existing) {
    return res
      .status(404)
      .json({ error: "Purchase order not found", code: "not_found" });
  }
  if (FROZEN_STATUSES.includes(existing.status)) {
    return res.status(409).json({
      error: `Cannot edit tracking on a PO in status '${existing.status}'.`,
      code: "not_editable",
    });
  }

  const entry: TrackingEntry = {
    id: newTrackingId(),
    provider: parsed.data.provider,
    tracking_number: parsed.data.tracking_number,
    tracking_url: parsed.data.tracking_url ?? "",
    created_at: new Date().toISOString(),
    created_by_user_id: userId,
    // Carrier ETA fields — filled by the refresh endpoint / cron.
    carrier_eta: null,
    carrier_status: "pending",
    carrier_eta_fetched_at: null,
    carrier_detail: null,
  };

  const next = [...parseTracking(existing.tracking), entry];
  await persistTracking(service, id, next);

  // Auto-advance the workflow status: a PO with a tracking number is in transit
  // with a shipment to watch → "Shipped (Waiting on Arrival)". Idempotent +
  // non-fatal, and skipped once the goods have arrived / the PO is dead.
  if (
    !PO_STATUS_AUTOSHIP_BLOCKED_LIFECYCLE.includes(existing.status) &&
    existing.po_status !== PO_STATUS_SHIPPED_WAITING
  ) {
    try {
      await service.updatePurchaseOrders([
        { id, po_status: PO_STATUS_SHIPPED_WAITING },
      ]);
    } catch {
      /* non-fatal — tracking already saved */
    }
  }

  return res.status(201).json({ tracking: next });
}

export async function PUT(
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
  const parsed = updateTrackingSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(zodErrorToBody(parsed.error));
  }

  const service = getPurchaseOrdersService(req);
  const existing = await loadPo(service, id);
  if (!existing) {
    return res
      .status(404)
      .json({ error: "Purchase order not found", code: "not_found" });
  }
  if (FROZEN_STATUSES.includes(existing.status)) {
    return res.status(409).json({
      error: `Cannot edit tracking on a PO in status '${existing.status}'.`,
      code: "not_editable",
    });
  }

  const current = parseTracking(existing.tracking);
  const idx = current.findIndex((t) => t.id === parsed.data.tracking_id);
  if (idx === -1) {
    return res
      .status(404)
      .json({ error: "Tracking entry not found", code: "not_found" });
  }

  const next = current.map((t, i) =>
    i === idx
      ? {
          ...t,
          provider: parsed.data.provider,
          tracking_number: parsed.data.tracking_number,
          tracking_url: parsed.data.tracking_url ?? "",
          // Number/provider may have changed → old ETA is stale, re-fetch.
          carrier_eta: null,
          carrier_status: "pending" as const,
          carrier_eta_fetched_at: null,
          carrier_detail: null,
        }
      : t
  );
  await persistTracking(service, id, next);

  return res.json({ tracking: next });
}

export async function DELETE(
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
  const parsed = deleteTrackingSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(zodErrorToBody(parsed.error));
  }

  const service = getPurchaseOrdersService(req);
  const existing = await loadPo(service, id);
  if (!existing) {
    return res
      .status(404)
      .json({ error: "Purchase order not found", code: "not_found" });
  }
  if (FROZEN_STATUSES.includes(existing.status)) {
    return res.status(409).json({
      error: `Cannot edit tracking on a PO in status '${existing.status}'.`,
      code: "not_editable",
    });
  }

  const next = parseTracking(existing.tracking).filter(
    (t) => t.id !== parsed.data.tracking_id
  );
  await persistTracking(service, id, next);

  return res.json({ tracking: next });
}
