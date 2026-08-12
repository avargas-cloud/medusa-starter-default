/**
 * src/api/admin/pos/price-batches/[id]/reject/route.ts
 *
 * POST /admin/pos/price-batches/:id/reject — no PIN (rejecting doesn't write
 * money). Body: { reason: string } (required, non-empty). Atomic claim
 * (submitted → rejected), same shape as approve's claim.
 */
import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { resolveActorIdentity } from "../../_lib/actor";
import { getPriceChangeService } from "../../_lib/service-resolver";

interface RejectBody {
  reason?: string;
}

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const logger = req.scope.resolve("logger");
  const id = req.params.id as string;
  const body = req.body as RejectBody;

  const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
  if (reason === "") {
    return res.status(400).json({ error: "reason is required" });
  }

  const service = getPriceChangeService(req);

  const [batch] = await service.listPriceChangeBatches({ id }, { take: 1 });
  if (!batch) {
    return res.status(404).json({ error: "Price change batch not found" });
  }

  try {
    const { userId, email } = await resolveActorIdentity(req);
    const knex = (req.scope as any).resolve("__pg_connection__");

    const claim = await knex.raw(
      `UPDATE price_change_batch
          SET status = 'rejected',
              reviewed_by_user_id = ?,
              reviewed_by_email = ?,
              reviewed_at = NOW(),
              reject_reason = ?
        WHERE id = ? AND status = 'submitted'
        RETURNING id`,
      [userId, email, reason, id]
    );

    if ((claim.rows as unknown[]).length === 0) {
      return res.status(409).json({
        code: "BATCH_NOT_PENDING",
        error:
          "This batch is no longer pending approval — a concurrent " +
          "approve/reject won, or it was already resolved.",
      });
    }

    return res.status(200).json({
      batch_id: id,
      display_number: batch.display_number,
      status: "rejected",
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[price-batches-reject] Failed to reject batch ${id}: ${msg}`);
    return res.status(500).json({ error: msg });
  }
};
