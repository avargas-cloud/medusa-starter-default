#!/usr/bin/env tsx
/**
 * cleanup-legacy-wp-metadata.ts
 *
 * One-shot SQL cleanup of WordPress/WooCommerce and QB-import-audit keys that
 * are no longer referenced by any active code path. Confirmed via grep against
 * backend/, web/, and store-pos/ on 2026-04-20.
 *
 * Drops on product.metadata:
 *   wc_id, wc_type, wc_attributes, woocommerce_id, grouped_products,
 *   package_height_in, package_length_in, package_width_in, package_weight_lb,
 *   qb_imported, qb_import_date, qb_import_source
 *
 * Drops on variant.metadata:
 *   shipping_synced
 *
 * NOTE: qb_vendor_id and qb_vendor_name on variant.metadata are cleaned up by
 * the mass-metadata-sync apply (not here). sales_description on product.metadata
 * is deferred to a post-mass-sync pass.
 *
 * Usage:
 *   DRY_RUN=true  npx medusa exec ./src/scripts/qb_sync/core_jobs/cleanup-legacy-wp-metadata.ts
 *   DRY_RUN=false npx medusa exec ./src/scripts/qb_sync/core_jobs/cleanup-legacy-wp-metadata.ts
 */
import type { ExecArgs } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/utils";

const PRODUCT_KEYS = [
  "wc_id",
  "wc_type",
  "wc_attributes",
  "woocommerce_id",
  "grouped_products",
  "package_height_in",
  "package_length_in",
  "package_width_in",
  "package_weight_lb",
  "qb_imported",
  "qb_import_date",
  "qb_import_source",
];

const VARIANT_KEYS = ["shipping_synced"];

function buildDropExpr(column: string, keys: string[]): string {
  return keys.reduce((acc, k) => `(${acc} - '${k}')`, column);
}

function buildHasAnyExpr(column: string, keys: string[]): string {
  return `${column} ?| array[${keys.map((k) => `'${k}'`).join(",")}]`;
}

export default async function cleanup({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const knex = (container as unknown as { resolve: (k: string) => unknown }).resolve("__pg_connection__") as {
    raw: (sql: string, bindings?: unknown[]) => Promise<{ rowCount: number; rows: Array<Record<string, unknown>> }>;
  };

  const dryRun = process.env.DRY_RUN !== "false";
  logger.info(`[cleanup-wp] ${dryRun ? "DRY RUN" : "LIVE"} — scanning…`);

  const productScan = await knex.raw(
    `SELECT COUNT(*)::int AS n
       FROM product
      WHERE deleted_at IS NULL
        AND ${buildHasAnyExpr("metadata", PRODUCT_KEYS)}`,
  );
  const productCount = Number((productScan.rows[0] as { n?: number } | undefined)?.n ?? 0);

  const variantScan = await knex.raw(
    `SELECT COUNT(*)::int AS n
       FROM product_variant
      WHERE deleted_at IS NULL
        AND ${buildHasAnyExpr("metadata", VARIANT_KEYS)}`,
  );
  const variantCount = Number((variantScan.rows[0] as { n?: number } | undefined)?.n ?? 0);

  // Per-key breakdown for the report.
  logger.info(`[cleanup-wp] PRODUCT keys to drop:`);
  for (const k of PRODUCT_KEYS) {
    const r = await knex.raw(
      `SELECT COUNT(*)::int AS n FROM product WHERE deleted_at IS NULL AND metadata ? '${k}'`,
    );
    const n = Number((r.rows[0] as { n?: number } | undefined)?.n ?? 0);
    logger.info(`   ${k.padEnd(24)} ${n}`);
  }
  logger.info(`[cleanup-wp] VARIANT keys to drop:`);
  for (const k of VARIANT_KEYS) {
    const r = await knex.raw(
      `SELECT COUNT(*)::int AS n FROM product_variant WHERE deleted_at IS NULL AND metadata ? '${k}'`,
    );
    const n = Number((r.rows[0] as { n?: number } | undefined)?.n ?? 0);
    logger.info(`   ${k.padEnd(24)} ${n}`);
  }

  logger.info(`[cleanup-wp] products that will be updated: ${productCount}`);
  logger.info(`[cleanup-wp] variants that will be updated: ${variantCount}`);

  if (dryRun) {
    logger.info(`[cleanup-wp] DRY_RUN=true — no writes. Re-run with DRY_RUN=false.`);
    return;
  }

  const prodSql = `
    UPDATE product
       SET metadata = ${buildDropExpr("metadata", PRODUCT_KEYS)},
           updated_at = NOW()
     WHERE deleted_at IS NULL
       AND ${buildHasAnyExpr("metadata", PRODUCT_KEYS)}
  `;
  const prodRes = await knex.raw(prodSql);
  logger.info(`[cleanup-wp] product.metadata rows updated: ${prodRes.rowCount}`);

  const varSql = `
    UPDATE product_variant
       SET metadata = ${buildDropExpr("metadata", VARIANT_KEYS)},
           updated_at = NOW()
     WHERE deleted_at IS NULL
       AND ${buildHasAnyExpr("metadata", VARIANT_KEYS)}
  `;
  const varRes = await knex.raw(varSql);
  logger.info(`[cleanup-wp] variant.metadata rows updated: ${varRes.rowCount}`);

  logger.info(`[cleanup-wp] done.`);
}
