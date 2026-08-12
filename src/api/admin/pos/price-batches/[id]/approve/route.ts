/**
 * src/api/admin/pos/price-batches/[id]/approve/route.ts
 *
 * POST /admin/pos/price-batches/:id/approve — PIN-gated. Applies the batch's
 * `new_*` values via the SAME engine the bulk editor uses
 * (`applyPriceRowsInTransaction` / `runPriceRowsPostCommit`), claiming the
 * batch atomically first so two concurrent approvals can't both apply it.
 *
 * Money invariant: a batch line may have changed only retail OR only
 * wholesale — `writeVariantPrices` writes ONLY the side(s) passed (a
 * variant with no wholesale row never gets one materialized by a retail-only
 * approve). A single-sided change is validated against the LIVE value of the
 * OTHER side at approve time (not the submit-time snapshot, and never
 * completed onto the write — the untouched side stays untouched); if that
 * violates wholesale ≤ retail, the LINE fails with a clear reason instead of
 * silently clamping or aborting the whole batch.
 */
import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ContainerRegistrationKeys } from "@medusajs/utils";

import {
  extractSupervisorPin,
  guardSupervisorPin,
  pinGuardResponse,
  resolveActorId,
} from "../../../../../../lib/pos/supervisor-pin-guard";
import type { PinConn } from "../../../../../../lib/pos/verify-supervisor-pin";
import {
  applyPriceRowsInTransaction,
  runPriceRowsPostCommit,
  type ApplyPriceRow,
  type ApplyPriceRowsCoreResult,
  type ApplyPriceVariant,
} from "../../../../../../lib/pos/apply-price-rows";

import { resolveActorIdentity } from "../../_lib/actor";
import { loadLiveVariantSnapshots } from "../../_lib/live-variant-snapshot";
import { getPriceChangeService } from "../../_lib/service-resolver";
import type { PriceChangeLineRow } from "../../_lib/types";

class BatchNotPendingError extends Error {}

interface LineFailure {
  variant_id: string;
  sku: string | null;
  reason: string;
}

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const logger = req.scope.resolve("logger");
  const id = req.params.id as string;
  const service = getPriceChangeService(req);

  // ── Existence check FIRST — a bad id must not burn a PIN attempt. ────────
  const [batch] = await service.listPriceChangeBatches({ id }, { take: 1 });
  if (!batch) {
    return res.status(404).json({ error: "Price change batch not found" });
  }

  // ── Supervisor PIN — this is the money-writing step of the flow. ─────────
  const knex = (req.scope as any).resolve("__pg_connection__");
  const guard = await guardSupervisorPin({
    scope: req.scope as unknown as { resolve: (k: string) => unknown },
    db: knex as PinConn,
    pin: extractSupervisorPin(req),
    actorId: resolveActorId(req),
  });
  if (!guard.ok) {
    const { status, body } = pinGuardResponse(guard);
    return res.status(status).json(body);
  }

  try {
    const lines = (await service.listPriceChangeLines(
      { batch_id: id },
      { order: { created_at: "ASC" } }
    )) as unknown as PriceChangeLineRow[];

    const query = req.scope.resolve(ContainerRegistrationKeys.QUERY) as {
      graph: (args: unknown) => Promise<{ data: unknown[] }>;
    };
    const variantIds = Array.from(new Set(lines.map((l) => l.variant_id)));
    const snapshots = await loadLiveVariantSnapshots(query, knex, variantIds);

    const rows: ApplyPriceRow[] = [];
    const failed: LineFailure[] = [];
    const variantMap = new Map<string, ApplyPriceVariant>();

    for (const line of lines) {
      const snap = snapshots.get(line.variant_id);
      if (!snap) {
        failed.push({
          variant_id: line.variant_id,
          sku: line.sku,
          reason: "variant no longer found",
        });
        continue;
      }

      const row: ApplyPriceRow = { variant_id: line.variant_id };

      if (line.new_cost !== null && line.new_cost !== undefined) {
        row.cost = Number(line.new_cost);
      }

      const hasRetailChange = line.new_retail !== null && line.new_retail !== undefined;
      const hasWholesaleChange =
        line.new_wholesale !== null && line.new_wholesale !== undefined;

      // The engine now writes a side ONLY if it's passed — so a line that
      // only changed one side of the pair is validated against the LIVE
      // value of the OTHER side (if it exists) but is NEVER completed onto
      // the engine call: passing undefined for the untouched side means it
      // stays exactly as-is (no row created for a variant that had none).
      if (hasRetailChange && hasWholesaleChange) {
        const newRetail = Number(line.new_retail);
        const newWholesale = Number(line.new_wholesale);
        if (newWholesale > newRetail) {
          failed.push({
            variant_id: line.variant_id,
            sku: line.sku,
            reason: `wholesale ($${newWholesale}) would exceed retail ($${newRetail}) — rejected, not clamped`,
          });
          continue;
        }
        row.retail_price = newRetail;
        row.wholesale_price = newWholesale;
      } else if (hasRetailChange) {
        const newRetail = Number(line.new_retail);
        const liveWholesale = snap.current_wholesale;
        if (liveWholesale !== null && liveWholesale > newRetail) {
          failed.push({
            variant_id: line.variant_id,
            sku: line.sku,
            reason: `live wholesale ($${liveWholesale}) would exceed new retail ($${newRetail}) — rejected, not clamped`,
          });
          continue;
        }
        row.retail_price = newRetail;
      } else if (hasWholesaleChange) {
        const newWholesale = Number(line.new_wholesale);
        const liveRetail = snap.current_retail;
        if (liveRetail !== null && newWholesale > liveRetail) {
          failed.push({
            variant_id: line.variant_id,
            sku: line.sku,
            reason: `new wholesale ($${newWholesale}) would exceed live retail ($${liveRetail}) — rejected, not clamped`,
          });
          continue;
        }
        row.wholesale_price = newWholesale;
      }

      if (
        row.cost === undefined &&
        row.retail_price === undefined &&
        row.wholesale_price === undefined
      ) {
        // Line carries no new_* at all — submit already drops no-op rows, so
        // this only happens if the batch was hand-edited; skip silently.
        continue;
      }

      variantMap.set(line.variant_id, {
        id: line.variant_id,
        sku: snap.sku,
        metadata: snap.metadata,
        price_set: snap.price_set_id ? { id: snap.price_set_id } : null,
      });
      rows.push(row);
    }

    const { userId, email } = await resolveActorIdentity(req);

    // ── DB writes (apply) + status flip: ONE transaction. ────────────────────
    let core: ApplyPriceRowsCoreResult | undefined;
    try {
      await knex.transaction(async (trx: PinConn) => {
        const claim = await trx.raw(
          `UPDATE price_change_batch
              SET status = 'approved',
                  reviewed_by_user_id = ?,
                  reviewed_by_email = ?,
                  reviewed_at = NOW()
            WHERE id = ? AND status = 'submitted'
            RETURNING id`,
          [userId, email, id]
        );
        if ((claim.rows as unknown[]).length === 0) {
          throw new BatchNotPendingError();
        }

        core = await applyPriceRowsInTransaction(trx, logger, variantMap, rows);
      });
    } catch (err) {
      if (err instanceof BatchNotPendingError) {
        return res.status(409).json({
          code: "BATCH_NOT_PENDING",
          error:
            "This batch is no longer pending approval — a concurrent approval " +
            "won, or it was already approved/rejected.",
        });
      }
      throw err;
    }

    // ── Post-commit: MeiliSearch + QB enqueue (never inline to the write tx). ─
    await runPriceRowsPostCommit(
      req.scope as unknown as { resolve: (k: string) => unknown },
      logger,
      core!
    );

    const appliedSummary = {
      updated: core!.results.length,
      qb_enqueued: core!.results.filter((r) => r.qb_enqueued).length,
      skipped_qb: core!.skippedQb.length,
      failed: failed.length,
    };
    await service.updatePriceChangeBatches({
      id,
      applied_summary: appliedSummary,
    });

    return res.status(200).json({
      batch_id: id,
      display_number: batch.display_number,
      updated: core!.results.length,
      results: core!.results,
      skipped_qb: core!.skippedQb,
      failed,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[price-batches-approve] Failed to approve batch ${id}: ${msg}`);
    return res.status(500).json({ error: msg });
  }
};
