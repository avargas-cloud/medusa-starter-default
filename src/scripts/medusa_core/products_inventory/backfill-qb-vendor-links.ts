import { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/utils";

import { QUICKBOOKS_CATALOG_MODULE } from "../../../modules/quickbooks-catalog";

type Args = {
  container: MedusaContainer;
};

/**
 * Backfill qb_vendor ↔ product_variant remote links.
 *
 * Reads variant.metadata.qb_vendor_name (legacy field) and matches it against
 * qb_vendor.full_name. For every match, creates a remote link and also patches
 * variant.metadata.qb_vendor_list_id for denormalized lookups.
 *
 * Idempotent: skips links that already exist (Medusa's link.create throws on
 * duplicates; we detect and ignore). Run with `--dry-run` to preview counts.
 */
export default async function backfillQbVendorLinks({ container }: Args) {
  const logger = container.resolve("logger");
  const query = container.resolve(ContainerRegistrationKeys.QUERY);
  const link = container.resolve(ContainerRegistrationKeys.LINK);
  const knex = (container as any).resolve("__pg_connection__");

  const DRY_RUN = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";

  logger.info(
    `[backfill-qb-vendor-links] starting${DRY_RUN ? " (DRY RUN)" : ""}…`
  );

  const { data: vendors } = await query.graph({
    entity: "qb_vendor",
    fields: ["id", "full_name", "name"],
    pagination: { skip: 0, take: 5000 },
  });

  const byName = new Map<string, string>();
  for (const v of vendors as Array<{ id: string; full_name: string; name: string }>) {
    byName.set(v.full_name.trim().toLowerCase(), v.id);
    byName.set(v.name.trim().toLowerCase(), v.id);
  }
  logger.info(`  loaded ${vendors.length} qb_vendor rows`);

  const rows = await knex.raw(
    `SELECT id, sku, metadata->>'qb_vendor_name' AS vendor_name
       FROM product_variant
      WHERE deleted_at IS NULL
        AND metadata->>'qb_vendor_name' IS NOT NULL
        AND metadata->>'qb_vendor_name' <> ''`
  );
  const variants: Array<{ id: string; sku: string; vendor_name: string }> =
    rows.rows;

  logger.info(`  found ${variants.length} variants with qb_vendor_name`);

  let linked = 0;
  let alreadyLinked = 0;
  let unmatched = 0;
  let metadataPatched = 0;
  const unmatchedNames = new Set<string>();

  for (const v of variants) {
    const key = v.vendor_name.trim().toLowerCase();
    const vendorId = byName.get(key);

    if (!vendorId) {
      unmatched++;
      unmatchedNames.add(v.vendor_name);
      continue;
    }

    if (DRY_RUN) {
      linked++;
      continue;
    }

    try {
      await link.create({
        [QUICKBOOKS_CATALOG_MODULE]: { qb_vendor_id: vendorId },
        [Modules.PRODUCT]: { product_variant_id: v.id },
      });
      linked++;
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      if (/duplicate|unique|already/i.test(msg)) {
        alreadyLinked++;
      } else {
        logger.warn(
          `  link failed for variant ${v.sku} → vendor ${vendorId}: ${msg}`
        );
      }
    }

    const { data: vendorRow } = await query.graph({
      entity: "qb_vendor",
      fields: ["qb_list_id"],
      filters: { id: vendorId },
      pagination: { skip: 0, take: 1 },
    });
    const listId = (vendorRow?.[0] as any)?.qb_list_id ?? null;
    if (listId) {
      await knex.raw(
        `UPDATE product_variant
           SET metadata = COALESCE(metadata, '{}'::jsonb)
             || jsonb_build_object('qb_vendor_list_id', ?::text)
         WHERE id = ?`,
        [listId, v.id]
      );
      metadataPatched++;
    }
  }

  logger.info("\n=== Backfill Summary ===");
  logger.info(`  Variants scanned:        ${variants.length}`);
  logger.info(`  Links created:           ${linked}`);
  logger.info(`  Already linked (skip):   ${alreadyLinked}`);
  logger.info(`  Metadata patched:        ${metadataPatched}`);
  logger.info(`  Unmatched variants:      ${unmatched}`);
  if (unmatchedNames.size > 0 && unmatchedNames.size <= 30) {
    logger.info(`  Unmatched names:`);
    for (const n of unmatchedNames) logger.info(`    · ${n}`);
  } else if (unmatchedNames.size > 30) {
    logger.info(`  Unmatched names: ${unmatchedNames.size} distinct (first 30):`);
    Array.from(unmatchedNames)
      .slice(0, 30)
      .forEach((n) => logger.info(`    · ${n}`));
  }
  if (DRY_RUN) logger.info("\n  ⚠️  DRY RUN — no database writes occurred.");
}
