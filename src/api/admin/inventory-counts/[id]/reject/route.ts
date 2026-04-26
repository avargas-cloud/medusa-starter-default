/**
 * src/api/admin/inventory-counts/[id]/reject/route.ts
 *
 * POST /admin/inventory-counts/:id/reject (manager-only)
 *
 * Terminal status change: a rejected count cannot be re-submitted. The
 * cashier must create a new count if a recount is required.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import {
  ManagerRoleRequiredError,
  UnauthenticatedError,
  requireManager,
} from "../../_lib/auth";
import { zodErrorToBody } from "../../_lib/format";
import { getInventoryCountService } from "../../_lib/service-resolver";
import { rejectSchema } from "../../_lib/validators";

export async function POST(
  req: AuthenticatedMedusaRequest<{ review_notes: string }>,
  res: MedusaResponse
) {
  let reviewerId: string;
  try {
    reviewerId = await requireManager(req);
  } catch (err) {
    if (
      err instanceof ManagerRoleRequiredError ||
      err instanceof UnauthenticatedError
    ) {
      return res
        .status(err.status)
        .json({ error: err.message, code: err.code });
    }
    throw err;
  }

  const parsed = rejectSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(zodErrorToBody(parsed.error));
  }
  const { review_notes } = parsed.data;

  const { id } = req.params;
  const service = getInventoryCountService(req);

  const [count] = await service.listInventoryCounts({ id }, { take: 1 });
  if (!count) {
    return res
      .status(404)
      .json({ error: "inventory_count not found", code: "not_found" });
  }
  if (count.status !== "submitted") {
    return res.status(409).json({
      error: `Only submitted counts may be rejected (current status: ${count.status})`,
      code: "not_submitted",
    });
  }

  const [updated] = await service.updateInventoryCounts([
    {
      id,
      status: "rejected",
      reviewed_by_user_id: reviewerId,
      reviewed_at: new Date(),
      review_notes,
    },
  ]);

  return res.json({ inventory_count: updated });
}
