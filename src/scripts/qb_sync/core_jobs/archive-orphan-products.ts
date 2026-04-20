#!/usr/bin/env tsx
/**
 * archive-orphan-products.ts
 *
 * Reads a mass-sync plan JSON and sets `product.status = "draft"` for every
 * product whose variant is listed in `plan.orphans` (Medusa has quickbooks_id,
 * QB did not return the item — i.e. deleted or inactive in QB).
 *
 * Safe, reversible: only flips status, no delete, no metadata change.
 *
 * Usage:
 *   PLAN_FILE=/tmp/qb-mass-sync-plan-<ts>.json \
 *     npx medusa exec ./src/scripts/qb_sync/core_jobs/archive-orphan-products.ts
 *
 *   # Dry run:
 *   DRY_RUN=true PLAN_FILE=/tmp/qb-mass-sync-plan-<ts>.json \
 *     npx medusa exec ./src/scripts/qb_sync/core_jobs/archive-orphan-products.ts
 */
import type { ExecArgs } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/utils";
import * as fs from "fs";

type PlanShape = {
  orphans: Array<{
    variantId: string;
    productId: string;
    sku: string | null;
    listId: string;
  }>;
};

export default async function archiveOrphans({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const knex = (container as unknown as { resolve: (k: string) => unknown }).resolve("__pg_connection__") as {
    raw: (sql: string, bindings?: unknown[]) => Promise<{ rowCount: number; rows: Array<Record<string, unknown>> }>;
  };

  const planFile = process.env.PLAN_FILE;
  if (!planFile) {
    throw new Error("PLAN_FILE env is required (path to a mass-sync plan JSON)");
  }
  const dryRun = process.env.DRY_RUN !== "false";

  const plan: PlanShape = JSON.parse(fs.readFileSync(planFile, "utf8"));
  const productIds = Array.from(new Set(plan.orphans.map((o) => o.productId)));
  logger.info(
    `[archive-orphans] ${plan.orphans.length} orphan variants → ${productIds.length} unique products${dryRun ? " (DRY RUN)" : ""}`,
  );

  if (productIds.length === 0) {
    logger.info("[archive-orphans] nothing to do");
    return;
  }

  for (const o of plan.orphans) {
    logger.info(`  ${o.sku ?? "(no sku)"}  product=${o.productId}  variant=${o.variantId}  listId=${o.listId}`);
  }

  if (dryRun) {
    logger.info("[archive-orphans] DRY_RUN=true — no writes. Re-run with DRY_RUN=false to apply.");
    return;
  }

  const res = await knex.raw(
    `UPDATE product
        SET status = 'draft', updated_at = NOW()
      WHERE id = ANY(?::text[])
        AND status <> 'draft'`,
    [productIds],
  );
  logger.info(`[archive-orphans] flipped ${res.rowCount} products to status=draft`);
}
