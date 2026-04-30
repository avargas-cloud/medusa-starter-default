/**
 * src/api/admin/purchase-orders/[id]/receiving-drafts/route.ts
 *
 * POST /admin/purchase-orders/:id/receiving-drafts
 *
 * Appends a receiving worksheet snapshot to po.metadata.receiving_drafts[].
 * Used by the POS "Receiving Draft" modal to capture the physical-arrival
 * audit trail (boxes, weights, who-received-what, when).
 *
 * The snapshot is purely informational — it does NOT mutate inventory or
 * line qty_received. Recording an actual receipt still goes through the
 * existing /receive endpoint.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { z } from "zod";

import { getActorUserId, UnauthenticatedError } from "../../_lib/auth";
import { zodErrorToBody } from "../../_lib/format";
import { getPurchaseOrdersService } from "../../_lib/service-resolver";

const boxAssignmentSchema = z.object({
  box_no: z.number().int().nonnegative(),
  qty: z.number().int().nonnegative(),
});

const draftItemSchema = z.object({
  line_id: z.string(),
  num: z.number().int().nonnegative(),
  sku: z.string(),
  mpn: z.string().nullable().optional(),
  qty_ordered: z.number().int().nonnegative(),
  qty_backorder: z.number().int().nonnegative(),
  qty_received: z.number().int().nonnegative(),
  boxes: z.array(boxAssignmentSchema),
});

const boxDefSchema = z.object({
  box_no: z.number().int().nonnegative(),
  weight: z.string(),
});

const draftSchema = z.object({
  draft_id: z.string(),
  created_at: z.string(),
  date: z.string(),
  receiver: z.string(),
  manager: z.string(),
  num_boxes: z.number().int().nonnegative(),
  boxes: z.array(boxDefSchema),
  items: z.array(draftItemSchema),
});

interface PoHeaderWithMeta {
  id: string;
  metadata: Record<string, unknown> | null;
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
  const parsed = draftSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(zodErrorToBody(parsed.error));
  }
  const draft = parsed.data;

  const service = getPurchaseOrdersService(req);
  const po = (await service
    .retrievePurchaseOrder(id)
    .catch(() => null)) as unknown as PoHeaderWithMeta | null;

  if (!po) {
    return res
      .status(404)
      .json({ error: "Purchase order not found", code: "not_found" });
  }

  const metadata: Record<string, unknown> = { ...(po.metadata ?? {}) };
  const existing = Array.isArray(metadata.receiving_drafts)
    ? (metadata.receiving_drafts as unknown[])
    : [];

  const stamped = {
    ...draft,
    saved_at: new Date().toISOString(),
    saved_by_user_id: userId,
  };

  metadata.receiving_drafts = [...existing, stamped];

  await service.updatePurchaseOrders([{ id, metadata }]);

  return res.json({ receiving_draft: stamped });
}
