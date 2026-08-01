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
import { ContainerRegistrationKeys } from "@medusajs/utils";
import type { Knex } from "knex";

import { releaseClaimsForCount } from "../../../../../lib/inventory-count/item-claims";
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

  const id = req.params.id as string;
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

  // Reject is terminal and deliberately leaves the LINES untouched (they keep
  // status 'pending' with their frozen delta as an audit trail). Nothing will
  // ever apply them, so their hold on the items has to be dropped here — a
  // line-status-driven release would keep those SKUs locked forever and block
  // the very recount this rejection is asking for.
  const knex = req.scope.resolve(
    ContainerRegistrationKeys.PG_CONNECTION
  ) as Knex;
  await releaseClaimsForCount(knex, id);

  return res.json({ inventory_count: updated });
}
