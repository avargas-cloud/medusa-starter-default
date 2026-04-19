/**
 * src/api/admin/qb-catalog/inventory-adjustment-pipeline/[id]/retry/route.ts
 *
 * POST /admin/qb-catalog/inventory-adjustment-pipeline/:id/retry
 *
 * Resets a pipeline row's add-phase or void-phase back to 'waiting' so the
 * cron poller picks it up on the next tick. Returns 409 if neither phase
 * is in error.
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ContainerRegistrationKeys } from "@medusajs/utils";

import { INVENTORY_COUNT_MODULE } from "../../../../../../modules/inventory-count";

interface PipelineRowLite {
  id: string;
  status: string;
  void_status: string | null;
}

interface InventoryCountServiceLike {
  updateQbInventoryAdjustmentPipelines: (
    update: Record<string, unknown> | Array<Record<string, unknown>>
  ) => Promise<unknown>;
}

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const id = req.params.id as string;
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY);
  const service = req.scope.resolve(
    INVENTORY_COUNT_MODULE
  ) as unknown as InventoryCountServiceLike;

  const { data: rows } = await query.graph({
    entity: "qb_inventory_adjustment_pipeline",
    fields: ["id", "status", "void_status"],
    filters: { id } as Record<string, unknown>,
    pagination: { skip: 0, take: 1 },
  });
  const row = (rows as unknown as PipelineRowLite[])[0];
  if (!row) {
    return res.status(404).json({ error: "Pipeline row not found", code: "not_found" });
  }

  const update: Record<string, unknown> = { id };
  let retriedAdd = false;
  let retriedVoid = false;

  if (row.status === "error") {
    update.status = "waiting";
    update.retries = 0;
    update.last_error = null;
    update.next_retry_at = null;
    retriedAdd = true;
  }
  if (row.void_status === "error") {
    update.void_status = "waiting";
    update.void_retries = 0;
    update.void_last_error = null;
    update.void_next_retry_at = null;
    retriedVoid = true;
  }

  if (!retriedAdd && !retriedVoid) {
    return res.status(409).json({
      error: "Neither add nor void phase is in error — nothing to retry",
      code: "not_in_error",
    });
  }

  await service.updateQbInventoryAdjustmentPipelines(update);

  const phase = retriedAdd && retriedVoid ? "both" : retriedAdd ? "add" : "void";
  return res.json({ ok: true, retried_phase: phase });
};
