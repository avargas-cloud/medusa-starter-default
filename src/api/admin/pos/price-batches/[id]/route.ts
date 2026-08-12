/**
 * src/api/admin/pos/price-batches/[id]/route.ts
 *
 * GET   /admin/pos/price-batches/:id — batch + lines, with LIVE current
 *   values re-read from DB so the manager decides with fresh data, not the
 *   submit-time snapshot.
 * PATCH /admin/pos/price-batches/:id — autosave a draft: REPLACES the full
 *   line set + note in one transaction. SOLO drafts (409 BATCH_NOT_DRAFT
 *   otherwise, via an atomic claim so a race with submit/discard can't leave
 *   a half-replaced batch).
 * DELETE /admin/pos/price-batches/:id — discard a draft (soft-delete). SOLO
 *   drafts (409 BATCH_NOT_DRAFT otherwise).
 */
import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ContainerRegistrationKeys } from "@medusajs/utils";

import type { TxManager } from "../_lib/display-number";
import { loadLiveVariantSnapshots } from "../_lib/live-variant-snapshot";
import { getPriceChangeService } from "../_lib/service-resolver";
import type { PriceChangeLineRow } from "../_lib/types";
import { validateDraftRows } from "../_lib/validate-draft-rows";
import { MAX_BULK_ROWS } from "../../prices/bulk/_lib/validate-bulk-rows";

const BATCH_NOT_DRAFT_ERROR = {
  code: "BATCH_NOT_DRAFT",
  error:
    "This batch is no longer a draft — it was submitted or discarded since " +
    "you last loaded it.",
};

class BatchNotDraftError extends Error {}

const num = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v);

export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const id = req.params.id as string;
  const service = getPriceChangeService(req);

  const [batch] = await service.listPriceChangeBatches({ id }, { take: 1 });
  if (!batch) {
    return res.status(404).json({ error: "Price change batch not found" });
  }

  const lines = (await service.listPriceChangeLines(
    { batch_id: id },
    { order: { created_at: "ASC" } }
  )) as unknown as PriceChangeLineRow[];

  const knex = (req.scope as any).resolve("__pg_connection__");
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY) as {
    graph: (args: unknown) => Promise<{ data: unknown[] }>;
  };
  const variantIds = Array.from(new Set(lines.map((l) => l.variant_id)));
  const live = await loadLiveVariantSnapshots(query, knex, variantIds);

  const decoratedLines = lines.map((l) => {
    const snapshot = live.get(l.variant_id);
    const current_cost = snapshot?.current_cost ?? null;
    const current_retail = snapshot?.current_retail ?? null;
    const current_wholesale = snapshot?.current_wholesale ?? null;

    const drifted =
      (l.old_cost !== null && num(l.old_cost) !== current_cost) ||
      (l.old_retail !== null && num(l.old_retail) !== current_retail) ||
      (l.old_wholesale !== null && num(l.old_wholesale) !== current_wholesale);

    return {
      ...l,
      current_cost,
      current_retail,
      current_wholesale,
      // Whether a live wholesale price ROW exists for this variant — the
      // draft editor needs this to reconstruct the retail/wholesale mirror
      // toggle on reopen, since a NULL new_wholesale is ambiguous between
      // "untouched" and "no wholesale price to touch".
      has_wholesale: current_wholesale !== null,
      drifted,
    };
  });

  return res.status(200).json({ batch, lines: decoratedLines });
};

interface DraftPatchBody {
  rows?: unknown;
  note?: string;
}

export const PATCH = async (req: MedusaRequest, res: MedusaResponse) => {
  const logger = req.scope.resolve("logger");
  const id = req.params.id as string;
  const body = req.body as DraftPatchBody;

  const { rows, errors, tooMany } = validateDraftRows(body);
  if (tooMany) {
    return res
      .status(400)
      .json({ error: `Too many rows (max ${MAX_BULK_ROWS})` });
  }
  if (!rows) {
    return res.status(400).json({ errors });
  }

  const note =
    typeof body?.note === "string" && body.note.trim() !== ""
      ? body.note.trim().slice(0, 2000)
      : null;

  const service = getPriceChangeService(req);

  const [batch] = await service.listPriceChangeBatches({ id }, { take: 1 });
  if (!batch) {
    return res.status(404).json({ error: "Price change batch not found" });
  }

  try {
    const savedAt = await service.withTransaction(async (ctx) => {
      const em = ctx.transactionManager as unknown as TxManager;

      // ── Atomic claim: only a `draft` can be autosaved. Same physical
      // transaction as the line replace below, so a race with submit/discard
      // either loses the claim (409, nothing touched) or wins it before
      // anything else can.
      const claim = await em.execute<Array<{ updated_at: string }>>(
        `UPDATE price_change_batch
            SET note = ?, line_count = ?, updated_at = now()
          WHERE id = ? AND status = 'draft'
          RETURNING updated_at`,
        [note, rows.length, id]
      );
      if (!claim?.[0]) {
        throw new BatchNotDraftError();
      }

      const existing = (await service.listPriceChangeLines(
        { batch_id: id },
        {},
        ctx
      )) as unknown as PriceChangeLineRow[];
      if (existing.length > 0) {
        await service.deletePriceChangeLines(
          existing.map((l) => l.id),
          ctx
        );
      }

      if (rows.length > 0) {
        await service.createPriceChangeLines(
          rows.map((row) => ({
            batch_id: id,
            variant_id: row.variant_id,
            product_id: row.product_id,
            sku: row.sku,
            description: row.description,
            old_cost: null,
            new_cost: row.cost ?? null,
            old_retail: null,
            new_retail: row.retail_price ?? null,
            old_wholesale: null,
            new_wholesale: row.wholesale_price ?? null,
          })),
          ctx
        );
      }

      return claim[0].updated_at;
    });

    return res.status(200).json({ batch_id: id, saved_at: savedAt });
  } catch (err: unknown) {
    if (err instanceof BatchNotDraftError) {
      return res.status(409).json(BATCH_NOT_DRAFT_ERROR);
    }
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[price-batches-patch] Failed to autosave draft ${id}: ${msg}`);
    return res.status(500).json({ error: msg });
  }
};

export const DELETE = async (req: MedusaRequest, res: MedusaResponse) => {
  const logger = req.scope.resolve("logger");
  const id = req.params.id as string;
  const service = getPriceChangeService(req);

  const [batch] = await service.listPriceChangeBatches({ id }, { take: 1 });
  if (!batch) {
    return res.status(404).json({ error: "Price change batch not found" });
  }
  if (batch.status !== "draft") {
    return res.status(409).json(BATCH_NOT_DRAFT_ERROR);
  }

  try {
    const lines = (await service.listPriceChangeLines({
      batch_id: id,
    })) as unknown as PriceChangeLineRow[];
    if (lines.length > 0) {
      await service.softDeletePriceChangeLines(lines.map((l) => l.id));
    }
    await service.softDeletePriceChangeBatches([id]);

    return res.status(200).json({ batch_id: id, deleted: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(
      `[price-batches-delete] Failed to discard draft ${id}: ${msg}`
    );
    return res.status(500).json({ error: msg });
  }
};
