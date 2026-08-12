import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ContainerRegistrationKeys } from "@medusajs/utils";

import {
  extractSupervisorPin,
  guardSupervisorPin,
  pinGuardResponse,
  resolveActorId,
} from "../../../../../lib/pos/supervisor-pin-guard";
import type { PinConn } from "../../../../../lib/pos/verify-supervisor-pin";
import {
  applyPriceRows,
  type ApplyPriceVariant,
} from "../../../../../lib/pos/apply-price-rows";

import { MAX_BULK_ROWS, validateBulkRows } from "./_lib/validate-bulk-rows";

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const logger = req.scope.resolve("logger");

  // ── 1. Validation FIRST — same ordering as the single-variant route: a
  // malformed body must not burn a PIN attempt. ─────────────────────────────
  const { rows, errors, tooMany } = validateBulkRows(req.body);
  if (tooMany) {
    return res
      .status(400)
      .json({ error: `Too many rows (max ${MAX_BULK_ROWS})` });
  }
  if (!rows) {
    return res.status(400).json({ errors });
  }

  // __pg_connection__ is a Knex instance in Medusa v2 (`?` bindings — never `$1`).
  const knex = (req.scope as any).resolve("__pg_connection__");
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY);

  // ── Supervisor PIN — identical gate to the single-variant route. ─────────
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
    // ── Load all variants in ONE query. ─────────────────────────────────────
    const variantIds = rows.map((r) => r.variant_id);
    const { data: variants } = await query.graph({
      entity: "product_variant",
      fields: ["id", "sku", "product_id", "metadata", "price_set.id"],
      filters: { id: variantIds },
    });

    const variantById = new Map<string, ApplyPriceVariant>(
      (variants as ApplyPriceVariant[]).map((v) => [v.id, v])
    );
    const missing = variantIds.filter((id) => !variantById.has(id));
    if (missing.length > 0) {
      return res.status(400).json({
        error: `Variant(s) not found: ${missing.join(", ")}`,
      });
    }

    const { results, skippedQb } = await applyPriceRows({
      knex,
      scope: req.scope as unknown as { resolve: (k: string) => unknown },
      logger,
      variants: variantById,
      rows,
    });

    return res.status(200).json({
      updated: results.length,
      results,
      skipped_qb: skippedQb,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[pos-prices-bulk] Failed to bulk-update prices: ${msg}`);
    return res.status(500).json({ error: msg });
  }
};
