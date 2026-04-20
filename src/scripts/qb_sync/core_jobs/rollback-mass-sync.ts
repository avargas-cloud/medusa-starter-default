#!/usr/bin/env tsx
/**
 * rollback-mass-sync.ts
 *
 * Restores product.metadata, variant.metadata, and vendor links to the state
 * captured in a snapshot JSON written by the mass-metadata-sync apply run.
 *
 * Usage:
 *   SNAPSHOT_FILE=/tmp/qb-mass-sync-snapshot-<ts>.json \
 *     npx medusa exec ./src/scripts/qb_sync/core_jobs/rollback-mass-sync.ts
 */
import type { ExecArgs } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/utils";
import * as fs from "fs";
import { QUICKBOOKS_CATALOG_MODULE } from "../../../modules/quickbooks-catalog";
import { readSnapshot } from "../lib/snapshot-before-apply";

const BATCH = 500;

export default async function rollback({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const remoteLink = container.resolve(ContainerRegistrationKeys.LINK);
  const knex = (container as unknown as { resolve: (k: string) => unknown }).resolve("__pg_connection__") as {
    raw: (sql: string, bindings?: unknown[]) => Promise<{ rowCount: number; rows: Array<Record<string, unknown>> }>;
  };

  const file = process.env.SNAPSHOT_FILE;
  if (!file) throw new Error("SNAPSHOT_FILE env is required");
  const snapshot = readSnapshot(file);
  logger.info(
    `[rollback] restoring from ${file} — ${snapshot.rows.length} products, generatedAt=${snapshot.generatedAt}`,
  );

  // Restore product.metadata.
  const productRows = snapshot.rows.map((r) => ({ id: r.productId, metadata: r.productMetadata ?? {} }));
  for (let i = 0; i < productRows.length; i += BATCH) {
    const chunk = productRows.slice(i, i + BATCH);
    await knex.raw(
      `UPDATE product AS t
          SET metadata = (u.metadata)::jsonb,
              updated_at = NOW()
         FROM UNNEST(?::text[], ?::text[]) AS u(id, metadata)
        WHERE t.id = u.id`,
      [chunk.map((r) => r.id), chunk.map((r) => JSON.stringify(r.metadata))],
    );
  }
  logger.info(`[rollback] restored ${productRows.length} products.metadata`);

  // Restore variant.metadata.
  const variantRows: Array<{ id: string; metadata: Record<string, unknown> }> = [];
  for (const row of snapshot.rows) {
    for (const v of row.variants) {
      variantRows.push({ id: v.id, metadata: v.metadata ?? {} });
    }
  }
  for (let i = 0; i < variantRows.length; i += BATCH) {
    const chunk = variantRows.slice(i, i + BATCH);
    await knex.raw(
      `UPDATE product_variant AS t
          SET metadata = (u.metadata)::jsonb,
              updated_at = NOW()
         FROM UNNEST(?::text[], ?::text[]) AS u(id, metadata)
        WHERE t.id = u.id`,
      [chunk.map((r) => r.id), chunk.map((r) => JSON.stringify(r.metadata))],
    );
  }
  logger.info(`[rollback] restored ${variantRows.length} variants.metadata`);

  // Restore vendor links: dismiss any link NOT in the snapshot, create any that WAS.
  const variantIds = variantRows.map((v) => v.id);
  const currentLinks = await knex.raw(
    `SELECT product_variant_id, qb_vendor_id
       FROM quickbooks_catalog_qb_vendor_product_product_variant
      WHERE deleted_at IS NULL
        AND product_variant_id = ANY(?::text[])`,
    [variantIds],
  );
  const currentByVariant = new Map<string, Set<string>>();
  for (const row of currentLinks.rows as Array<{ product_variant_id: string; qb_vendor_id: string }>) {
    const s = currentByVariant.get(row.product_variant_id) ?? new Set<string>();
    s.add(row.qb_vendor_id);
    currentByVariant.set(row.product_variant_id, s);
  }

  let dismissed = 0;
  let created = 0;
  for (const row of snapshot.rows) {
    for (const v of row.variants) {
      const desired = new Set(v.vendorLinkIds);
      const current = currentByVariant.get(v.id) ?? new Set<string>();
      for (const vendorId of current) {
        if (desired.has(vendorId)) continue;
        try {
          await remoteLink.dismiss({
            [QUICKBOOKS_CATALOG_MODULE]: { qb_vendor_id: vendorId },
            [Modules.PRODUCT]: { product_variant_id: v.id },
          });
          dismissed++;
        } catch (err) {
          logger.warn(`[rollback] dismiss link failed: ${String((err as Error).message)}`);
        }
      }
      for (const vendorId of desired) {
        if (current.has(vendorId)) continue;
        try {
          await remoteLink.create({
            [QUICKBOOKS_CATALOG_MODULE]: { qb_vendor_id: vendorId },
            [Modules.PRODUCT]: { product_variant_id: v.id },
          });
          created++;
        } catch (err) {
          const msg = String((err as Error).message ?? err);
          if (!/duplicate|unique|already/i.test(msg)) {
            logger.warn(`[rollback] create link failed: ${msg}`);
          }
        }
      }
    }
  }
  logger.info(`[rollback] links restored: dismissed=${dismissed} created=${created}`);
  logger.info(`[rollback] done.`);
}
