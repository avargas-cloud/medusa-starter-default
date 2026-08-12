/**
 * src/api/admin/pos/price-batches/route.ts
 *
 * GET  /admin/pos/price-batches       — list (optional ?status=), no PIN
 * POST /admin/pos/price-batches       — submit a batch for review, no PIN
 *   (the money write happens at approve — submit only records intent)
 */
import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ContainerRegistrationKeys } from "@medusajs/utils";

import { buildSubmitLines } from "./_lib/build-submit-lines";
import { resolveActorIdentity } from "./_lib/actor";
import {
  allocateNextDisplayNumber,
  type TxManager,
} from "./_lib/display-number";
import { getPriceChangeService } from "./_lib/service-resolver";
import {
  MAX_BULK_ROWS,
  validateBulkRows,
} from "../prices/bulk/_lib/validate-bulk-rows";

const VALID_STATUSES = new Set(["draft", "submitted", "approved", "rejected"]);

export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const service = getPriceChangeService(req);
  const statusParam = req.query.status;
  const status = typeof statusParam === "string" ? statusParam : undefined;

  if (status && !VALID_STATUSES.has(status)) {
    return res.status(400).json({ error: `Invalid status: ${status}` });
  }

  const where: Record<string, unknown> = {};
  if (status) where.status = status;

  // No pagination — repo convention until the set outgrows the ~1MB threshold.
  const batches = await service.listPriceChangeBatches(where, {
    order: { submitted_at: "DESC" },
  });

  const pendingCount =
    status === "submitted"
      ? batches.length
      : (await service.listPriceChangeBatches({ status: "submitted" })).length;

  return res.status(200).json({
    batches,
    pending_count: pendingCount,
  });
};

interface SubmitBody {
  rows?: unknown;
  note?: string;
}

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const logger = req.scope.resolve("logger");
  const body = req.body as SubmitBody;

  const { rows, errors, tooMany } = validateBulkRows(body);
  if (tooMany) {
    return res
      .status(400)
      .json({ error: `Too many rows (max ${MAX_BULK_ROWS})` });
  }
  if (!rows) {
    return res.status(400).json({ errors });
  }

  // Uncapped, human-typed field — never persisted unsanitized elsewhere in
  // this route, so a plain length cap is enough.
  const note =
    typeof body?.note === "string" && body.note.trim() !== ""
      ? body.note.trim().slice(0, 2000)
      : null;

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

    const { userId, email } = await resolveActorIdentity(req);
    const service = getPriceChangeService(req);

    // ── Claim the display number + create batch + lines: ONE transaction.
    // A rollback (line create fails, etc.) never advances the counter — same
    // gapless guarantee as invoice numbering.
    const batch = await service.withTransaction(async (ctx) => {
      const em = ctx.transactionManager as unknown as TxManager;
      const display_number = await allocateNextDisplayNumber(em);

      const created = await service.createPriceChangeBatches(
        {
          display_number,
          status: "submitted",
          note,
          created_by_user_id: userId,
          created_by_email: email,
          submitted_at: new Date(),
          line_count: linesToCreate.length,
        },
        ctx
      );

      await service.createPriceChangeLines(
        linesToCreate.map((line) => ({ ...line, batch_id: created.id })),
        ctx
      );

      return created;
    });

    return res.status(200).json({
      batch_id: batch.id,
      display_number: batch.display_number,
      line_count: linesToCreate.length,
      dropped_noop_rows: droppedNoopRows,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[price-batches] Failed to submit batch: ${msg}`);
    return res.status(500).json({ error: msg });
  }
};
