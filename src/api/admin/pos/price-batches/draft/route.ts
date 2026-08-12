/**
 * src/api/admin/pos/price-batches/draft/route.ts
 *
 * POST /admin/pos/price-batches/draft — create a new draft batch. No PIN (a
 * draft doesn't write money). Rows are validated LAXLY (shape only — no
 * wholesale<=retail, no "at least one field set", no noop-drop): a draft is
 * work-in-progress and can be empty or half-filled, that's the point.
 *
 * `sku`/`description` are stored as sent by the client (a display snapshot),
 * not re-resolved from a live lookup — keeps this endpoint cheap for
 * debounced autosave. `old_*` stays NULL on every draft line; the real
 * old-value snapshot happens at submit (POST /:id/submit), against
 * whatever's live at that moment.
 */
import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { resolveActorIdentity } from "../_lib/actor";
import {
  allocateNextDisplayNumber,
  type TxManager,
} from "../_lib/display-number";
import { getPriceChangeService } from "../_lib/service-resolver";
import { validateDraftRows } from "../_lib/validate-draft-rows";
import { MAX_BULK_ROWS } from "../../prices/bulk/_lib/validate-bulk-rows";

interface DraftBody {
  rows?: unknown;
  note?: string;
}

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const logger = req.scope.resolve("logger");
  const body = req.body as DraftBody;

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

  try {
    const { userId, email } = await resolveActorIdentity(req);
    const service = getPriceChangeService(req);

    // ── Claim the display number + create batch + lines: ONE transaction —
    // same gapless guarantee as the direct submit (POST /).
    const batch = await service.withTransaction(async (ctx) => {
      const em = ctx.transactionManager as unknown as TxManager;
      const display_number = await allocateNextDisplayNumber(em);

      const created = await service.createPriceChangeBatches(
        {
          display_number,
          status: "draft",
          note,
          created_by_user_id: userId,
          created_by_email: email,
          submitted_at: null,
          line_count: rows.length,
        },
        ctx
      );

      if (rows.length > 0) {
        await service.createPriceChangeLines(
          rows.map((row) => ({
            batch_id: created.id,
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

      return created;
    });

    return res.status(200).json({
      batch_id: batch.id,
      display_number: batch.display_number,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[price-batches-draft] Failed to create draft: ${msg}`);
    return res.status(500).json({ error: msg });
  }
};
