/**
 * src/api/admin/purchase-orders/[id]/tracking/route.ts
 *
 * GET    /admin/purchase-orders/:id/tracking  — shipments + allocatable lines
 * POST   /admin/purchase-orders/:id/tracking  — add a shipment, or a number to one
 * PUT    /admin/purchase-orders/:id/tracking  — edit shipment numbers + cargo
 * DELETE /admin/purchase-orders/:id/tracking  — remove a shipment, or one number
 *
 * Tracking is inbound logistics for the PO (delivery FROM the vendor). It is
 * local-only and never synced to QuickBooks, so it lives in its own tables +
 * route instead of the QB-aware PATCH on the parent resource.
 *
 * A SHIPMENT is the unit that says what is arriving; the carrier numbers hang
 * off it, because one truck routinely produces several waybills. The first
 * number is the master. A shipment either covers the whole PO ('all_order') or
 * carries specific quantities of specific lines ('by_line'); the scope is
 * DERIVED from whether the payload sends lines, so the client never declares it
 * and the two cannot disagree.
 *
 * THE TWO SCOPES DO NOT MIX ON ONE PO, AND THERE IS AT MOST ONE WHOLE-PO
 * SHIPMENT. Two deliveries cannot each contain all of the goods. A PO gets
 * split by EDITING the whole-PO shipment and marking what actually arrived,
 * which frees the rest; both add paths answer 409 `tracking_scope_conflict`
 * and say so.
 *
 * Editable while the PO is non-terminal (draft / submitted / partially_received
 * / received). Cancelled and voided POs are frozen.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import {
  loadRefreshableNumbers,
  settleExpectedAt,
} from "../../../../../lib/carrier-tracking/refresh-po";
import { PO_STATUS_RECEIVED_DRIVEN_SET } from "../../../../../lib/purchase-orders/po-received-status";
import { resolveAllocatablePoLines } from "../../../../../lib/purchase-orders/po-tracking-allocations";
import {
  resolvePoShipments,
  trackingCoverage,
  type PoShipmentView,
} from "../../../../../lib/purchase-orders/po-tracking-read";
import { getActorUserId, UnauthenticatedError } from "../../_lib/auth";
import { zodErrorToBody } from "../../_lib/format";
import {
  PO_STATUS_AUTOSHIP_BLOCKED_LIFECYCLE,
  PO_STATUS_SHIPPED_WAITING,
  reconcileShippedPoStatus,
} from "../../_lib/po-shipping-status";
import { getPurchaseOrdersService } from "../../_lib/service-resolver";
import {
  addNumberToShipment,
  createShipment,
  deleteShipment,
  removeNumberFromShipment,
  updateShipment,
  type ScopeConflict,
  type TrackingKnex,
  type TrackingWriteResult,
} from "../../_lib/tracking-writes";
import {
  addTrackingSchema,
  deleteTrackingSchema,
  updateTrackingSchema,
} from "../../_lib/validators";

interface PoHeaderLike {
  id: string;
  status: string;
  po_status: string | null;
  expected_at: Date | string | null;
}

const FROZEN_STATUSES = ["cancelled", "voided"];

function getDb(req: AuthenticatedMedusaRequest): TrackingKnex {
  return (
    req.scope as unknown as { resolve: (k: string) => TrackingKnex }
  ).resolve("__pg_connection__");
}

async function loadPo(
  service: ReturnType<typeof getPurchaseOrdersService>,
  id: string
): Promise<PoHeaderLike | null> {
  return (await service
    .retrievePurchaseOrder(id)
    .catch(() => null)) as unknown as PoHeaderLike | null;
}

/** Auth + PO existence + frozen check, shared by all four handlers. */
async function guard(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<{ po: PoHeaderLike; userId: string | null } | null> {
  let userId: string | null = null;
  try {
    userId = getActorUserId(req);
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      res.status(err.status).json({ error: err.message, code: err.code });
      return null;
    }
    throw err;
  }

  const { id } = req.params as { id: string };
  const po = await loadPo(getPurchaseOrdersService(req), id);
  if (!po) {
    res
      .status(404)
      .json({ error: "Purchase order not found", code: "not_found" });
    return null;
  }
  if (FROZEN_STATUSES.includes(po.status)) {
    res.status(409).json({
      error: `Cannot edit tracking on a PO in status '${po.status}'.`,
      code: "not_editable",
    });
    return null;
  }
  return { po, userId };
}

/** The response every handler returns: the PO's shipments, freshly read. */
async function trackingPayload(
  db: TrackingKnex,
  purchaseOrderId: string
): Promise<{ tracking: PoShipmentView[]; coverage: string }> {
  const tracking = await resolvePoShipments(db, purchaseOrderId);
  return { tracking, coverage: trackingCoverage(tracking) };
}

/**
 * Keep a shipped PO's `po_status` consistent after a tracking edit/removal:
 * with a number → "Waiting on Arrival", without → "Missing Tracking". No-op when
 * the PO isn't in a shipped state or its lifecycle is terminal. Non-fatal.
 */
async function reconcilePoStatusAfterTracking(
  service: ReturnType<typeof getPurchaseOrdersService>,
  po: PoHeaderLike,
  hasTracking: boolean
): Promise<void> {
  const reconciled = reconcileShippedPoStatus(
    po.po_status,
    po.status,
    hasTracking
  );
  if (!reconciled) return;
  try {
    await service.updatePurchaseOrders([{ id: po.id, po_status: reconciled }]);
  } catch {
    /* non-fatal — tracking change already saved */
  }
}

/**
 * 409 body when the write would contradict a delivery already on record.
 *
 * The message states the WAY OUT, not just the refusal. A whole-PO shipment
 * claims everything, so no second delivery can be added beside it — the split
 * is made by EDITING it and marking what actually arrived, which frees the
 * rest. (Adding another NUMBER to that same delivery is always allowed and is
 * a different operation entirely.)
 */
function scopeConflictBody(conflict: ScopeConflict) {
  const list = conflict.blocking.join(", ");
  const error =
    conflict.reason === "whole_po_exists"
      ? `${list} already covers this entire purchase order, so there is nothing ` +
        `left for another delivery. Open that shipment and mark what actually ` +
        `arrived in it — whatever you leave unmarked frees up for this one. ` +
        `If this number is just another waybill for the SAME delivery, add it ` +
        `to that shipment instead.`
      : `This purchase order is already broken out per item (${list}). A ` +
        `whole-PO tracking number would claim everything again — add this ` +
        `delivery with the items it carries instead.`;
  return { error, code: "tracking_scope_conflict", ...conflict };
}

/** Route a failed write to the 409 that explains it. */
function conflictBody(result: TrackingWriteResult) {
  if (result.invalidNumberSet) {
    return {
      error:
        "The tracking-number list changed while this shipment was open. Reload it and try again.",
      code: "stale_tracking_numbers",
    };
  }
  if (result.scopeConflict) return scopeConflictBody(result.scopeConflict);
  if (result.duplicateNumber) {
    return {
      error:
        `${result.duplicateNumber} is already on this purchase order. A carrier ` +
        `number may name only one delivery — otherwise its ETA would be counted ` +
        `twice against the same goods.`,
      code: "duplicate_tracking_number",
      duplicate_number: result.duplicateNumber,
    };
  }
  return {
    error: "Some quantities exceed what is left on the purchase order.",
    code: "allocation_exceeds_remaining",
    rejections: result.rejections,
  };
}

/** Apply stored automatic/manual ETAs without making a carrier request. */
async function settleStoredExpectedAt(
  service: ReturnType<typeof getPurchaseOrdersService>,
  db: TrackingKnex,
  po: PoHeaderLike
): Promise<void> {
  const numbers = await loadRefreshableNumbers(db, po.id);
  await settleExpectedAt(service, po, numbers);
}

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const ctx = await guard(req, res);
  if (!ctx) return;

  const db = getDb(req);
  const { id } = req.params as { id: string };
  const excludeId =
    typeof req.query.shipment_id === "string" ? req.query.shipment_id : null;

  // `lines` carries the remainder each editor row is seeded with. Excluding the
  // shipment being edited is what lets it show the units it already holds.
  const [payload, lines] = await Promise.all([
    trackingPayload(db, id),
    resolveAllocatablePoLines(db, id, excludeId),
  ]);

  return res.json({ ...payload, lines });
}

/**
 * With `shipment_id` → attach another carrier number to that delivery.
 * Without      → create a new delivery carrying the given number.
 */
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const ctx = await guard(req, res);
  if (!ctx) return;

  const parsed = addTrackingSchema.safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json(zodErrorToBody(parsed.error));

  const db = getDb(req);
  const { id } = req.params as { id: string };
  const number = {
    provider: parsed.data.provider,
    tracking_number: parsed.data.tracking_number,
    tracking_url: parsed.data.tracking_url ?? "",
    manual_eta: parsed.data.manual_eta ?? null,
  };

  const result = parsed.data.shipment_id
    ? await addNumberToShipment(
        db,
        id,
        parsed.data.shipment_id,
        number,
        ctx.userId
      )
    : await createShipment(
        db,
        id,
        { numbers: [number], lines: parsed.data.lines ?? [] },
        ctx.userId
      );

  if (!result.ok) return res.status(409).json(conflictBody(result));

  // Auto-advance the workflow status: a PO with a tracking number is in transit
  // with a shipment to watch → "Shipped (Waiting on Arrival)". Idempotent +
  // non-fatal, and skipped once the goods have arrived / the PO is dead. Also
  // skipped when the PO is already receipt-driven ("Fully Received" / "Partial
  // Rcvd Pending Partial") — the arrival state outranks an inbound-shipment tag.
  if (
    !PO_STATUS_AUTOSHIP_BLOCKED_LIFECYCLE.includes(ctx.po.status) &&
    ctx.po.po_status !== PO_STATUS_SHIPPED_WAITING &&
    !PO_STATUS_RECEIVED_DRIVEN_SET.includes(ctx.po.po_status ?? "")
  ) {
    try {
      await getPurchaseOrdersService(req).updatePurchaseOrders([
        { id, po_status: PO_STATUS_SHIPPED_WAITING },
      ]);
    } catch {
      /* non-fatal — tracking already saved */
    }
  }

  await settleStoredExpectedAt(getPurchaseOrdersService(req), db, ctx.po);

  return res.status(201).json(await trackingPayload(db, id));
}

/**
 * Edit a delivery's carrier numbers and what it carries.
 *
 * Sending no lines means "the whole PO"; sending lines means "these quantities".
 * The existing number set is edited in place: add/remove remain explicit
 * POST/DELETE actions, so an omitted row can never disappear by accident.
 */
export async function PUT(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const ctx = await guard(req, res);
  if (!ctx) return;

  const parsed = updateTrackingSchema.safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json(zodErrorToBody(parsed.error));

  const db = getDb(req);
  const { id } = req.params as { id: string };

  const current = await resolvePoShipments(db, id);
  if (!current.some((s) => s.id === parsed.data.shipment_id)) {
    return res
      .status(404)
      .json({ error: "Shipment not found", code: "not_found" });
  }

  const result = await updateShipment(
    db,
    id,
    parsed.data.shipment_id,
    parsed.data.lines ?? [],
    parsed.data.numbers?.map((number) => ({
      id: number.id,
      provider: number.provider,
      tracking_number: number.tracking_number,
      tracking_url: number.tracking_url ?? "",
      manual_eta: number.manual_eta ?? null,
    })),
    ctx.userId
  );
  if (!result.ok) return res.status(409).json(conflictBody(result));

  await settleStoredExpectedAt(getPurchaseOrdersService(req), db, ctx.po);

  const payload = await trackingPayload(db, id);
  await reconcilePoStatusAfterTracking(
    getPurchaseOrdersService(req),
    ctx.po,
    payload.tracking.length > 0
  );

  return res.json(payload);
}

/**
 * With `number_id` → drop that one carrier number (the delivery stays).
 * With `shipment_id` → drop the whole delivery, freeing its quantity.
 */
export async function DELETE(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const ctx = await guard(req, res);
  if (!ctx) return;

  const parsed = deleteTrackingSchema.safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json(zodErrorToBody(parsed.error));

  const db = getDb(req);
  const { id } = req.params as { id: string };

  if (parsed.data.number_id) {
    const removed = await removeNumberFromShipment(
      db,
      id,
      parsed.data.number_id
    );
    if (!removed.ok) {
      return res.status(409).json(
        removed.lastNumber
          ? {
              error:
                "That is the delivery's only tracking number. Remove the whole " +
                "shipment instead — which also frees the quantity it carries.",
              code: "last_number_on_shipment",
            }
          : { error: "Tracking number not found", code: "not_found" }
      );
    }
  } else if (parsed.data.shipment_id) {
    await deleteShipment(db, id, parsed.data.shipment_id);
  } else {
    return res.status(400).json({
      error: "Send either shipment_id or number_id.",
      code: "invalid_request",
    });
  }

  const payload = await trackingPayload(db, id);
  await reconcilePoStatusAfterTracking(
    getPurchaseOrdersService(req),
    ctx.po,
    payload.tracking.length > 0
  );

  return res.json(payload);
}
