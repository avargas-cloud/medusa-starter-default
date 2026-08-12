/**
 * src/api/admin/pos/price-batches/[id]/submit/route.ts
 *
 * POST /admin/pos/price-batches/:id/submit — converts a draft into a
 * submitted batch. No PIN (submit only records intent — same as the direct
 * POST /admin/pos/price-batches).
 *
 * Runs the SAME strict validation + live-snapshot + noop-drop logic as
 * POST / (shared via `_lib/build-submit-lines.ts`), after reconstructing
 * strict-shape rows from the draft's `new_*` fields (a NULL field on the
 * draft means "never touched", so it's simply omitted here — same shape
 * `validateBulkRows` expects from the bulk editor's raw body).
 *
 * A validation failure never writes anything: the read-only checks
 * (`validateBulkRows`, `buildSubmitLines`) all run BEFORE the write
 * transaction opens, so the batch is left untouched — still `draft` — on
 * any 400. The actual draft->submitted flip + line replace happen atomically
 * in ONE transaction, claimed with `WHERE status = 'draft'` so a concurrent
 * submit/discard can't double-submit.
 */
import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ContainerRegistrationKeys } from "@medusajs/utils";

import { buildSubmitLines } from "../../_lib/build-submit-lines";
import type { TxManager } from "../../_lib/display-number";
import { getPriceChangeService } from "../../_lib/service-resolver";
import type { PriceChangeLineRow } from "../../_lib/types";
import {
  MAX_BULK_ROWS,
  validateBulkRows,
} from "../../../prices/bulk/_lib/validate-bulk-rows";

class BatchNotDraftError extends Error {}

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const logger = req.scope.resolve("logger");
  const id = req.params.id as string;
  const service = getPriceChangeService(req);

  const [batch] = await service.listPriceChangeBatches({ id }, { take: 1 });
  if (!batch) {
    return res.status(404).json({ error: "Price change batch not found" });
  }
  if (batch.status !== "draft") {
    return res.status(409).json({
      code: "BATCH_NOT_DRAFT",
      error:
        "This batch is no longer a draft — it was already submitted or discarded.",
    });
  }

  const draftLines = (await service.listPriceChangeLines(
    { batch_id: id },
    { order: { created_at: "ASC" } }
  )) as unknown as PriceChangeLineRow[];

  const reconstructed: Record<string, unknown>[] = draftLines
    .map((l) => {
      const row: Record<string, unknown> = {
        variant_id: l.variant_id,
        product_id: l.product_id,
      };
      if (l.new_cost !== null && l.new_cost !== undefined) {
        row.cost = Number(l.new_cost);
      }
      if (l.new_retail !== null && l.new_retail !== undefined) {
        row.retail_price = Number(l.new_retail);
      }
      if (l.new_wholesale !== null && l.new_wholesale !== undefined) {
        row.wholesale_price = Number(l.new_wholesale);
      }
      return row;
    })
    // A draft legitimately holds rows the user added to the table but never
    // edited (all new_* NULL). They are working-set, not changes — DROP them
    // here instead of letting the strict validator reject the whole submit
    // with "row must set at least one of cost, retail_price, wholesale_price"
    // (bit the first UI submit of a reopened draft, PA-1009).
    .filter(
      (row) =>
        row.cost !== undefined ||
        row.retail_price !== undefined ||
        row.wholesale_price !== undefined
    );

  if (reconstructed.length === 0) {
    return res.status(400).json({ error: "no effective changes" });
  }

  const { rows, errors, tooMany } = validateBulkRows({ rows: reconstructed });
  if (tooMany) {
    return res
      .status(400)
      .json({ error: `Too many rows (max ${MAX_BULK_ROWS})` });
  }
  if (!rows) {
    return res.status(400).json({ errors });
  }

  const knex = (req.scope as any).resolve("__pg_connection__");
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY) as {
    graph: (args: unknown) => Promise<{ data: unknown[] }>;
  };

  try {
    const outcome = await buildSubmitLines(query, knex, rows);
    if (!outcome.ok) {
      return res.status(outcome.status).json(outcome.body);
    }
    const { linesToCreate, droppedNoopRows } = outcome.result;

    await service.withTransaction(async (ctx) => {
      const em = ctx.transactionManager as unknown as TxManager;

      const claim = await em.execute<Array<{ id: string }>>(
        `UPDATE price_change_batch
            SET status = 'submitted', submitted_at = now(), line_count = ?
          WHERE id = ? AND status = 'draft'
          RETURNING id`,
        [linesToCreate.length, id]
      );
      if (!claim?.[0]) {
        throw new BatchNotDraftError();
      }

      if (draftLines.length > 0) {
        await service.deletePriceChangeLines(
          draftLines.map((l) => l.id),
          ctx
        );
      }

      await service.createPriceChangeLines(
        linesToCreate.map((line) => ({ ...line, batch_id: id })),
        ctx
      );
    });

    return res.status(200).json({
      batch_id: id,
      display_number: batch.display_number,
      line_count: linesToCreate.length,
      dropped_noop_rows: droppedNoopRows,
    });
  } catch (err: unknown) {
    if (err instanceof BatchNotDraftError) {
      return res.status(409).json({
        code: "BATCH_NOT_DRAFT",
        error:
          "This batch is no longer a draft — a concurrent submit/discard won.",
      });
    }
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[price-batches-submit] Failed to submit batch ${id}: ${msg}`);
    return res.status(500).json({ error: msg });
  }
};
