/**
 * Apply mode for the mass metadata sync.
 *
 * Takes the PayloadMap + variant-vendor targets from the dry-run orchestrator
 * and writes them to the database using batched raw-SQL updates (same pattern
 * as legacy mass-cost-sync.ts) for performance. Emits Meili re-index events
 * for touched products at the end.
 *
 * Safe by design:
 *   - Caller MUST have written a snapshot first (the entrypoint enforces this).
 *   - Metadata writes REPLACE the full jsonb column — the payload builder
 *     already merged foreign keys, so unrelated data is preserved.
 *   - Vendor link operations dismiss stale links before creating the new one.
 */
import { ContainerRegistrationKeys, Modules } from "@medusajs/utils";
import type { MedusaContainer } from "@medusajs/framework/types";
import type { PayloadMap } from "./build-update-payload";
import {
  applyVendorLinkPlan,
  buildVendorLinkPlan,
  loadExistingVendorLinks,
  loadVendorCatalog,
  type VendorLinkReport,
} from "./resolve-vendor-links";
import { cleanupLegacyVendorKeys, type LegacyCleanupReport } from "./cleanup-legacy-vendor-keys";

const METADATA_BATCH = 500;

export type ApplyResult = {
  productsUpdated: number;
  variantsUpdated: number;
  vendorLinks: VendorLinkReport;
  legacyCleanup: LegacyCleanupReport;
  meiliReindexed: number;
  elapsedMs: number;
};

type Knex = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rowCount: number; rows: Array<Record<string, unknown>> }>;
};

async function bulkReplaceMetadata(
  knex: Knex,
  table: "product" | "product_variant",
  rows: Array<{ id: string; metadata: Record<string, unknown> }>,
): Promise<number> {
  if (rows.length === 0) return 0;
  let total = 0;
  for (let i = 0; i < rows.length; i += METADATA_BATCH) {
    const chunk = rows.slice(i, i + METADATA_BATCH);
    const ids = chunk.map((r) => r.id);
    const metas = chunk.map((r) => JSON.stringify(r.metadata));
    const sql = `
      UPDATE ${table} AS t
         SET metadata = (u.metadata)::jsonb,
             updated_at = NOW()
        FROM UNNEST(?::text[], ?::text[]) AS u(id, metadata)
       WHERE t.id = u.id
    `;
    const res = await knex.raw(sql, [ids, metas]);
    total += res.rowCount;
  }
  return total;
}

export type VendorTarget = {
  variantId: string;
  targetQbListId: string | null;
};

export async function applyMetadataSync(
  container: MedusaContainer,
  payloadMap: PayloadMap,
  vendorTargets: VendorTarget[],
  opts: { triggerMeili: boolean; skipLegacyCleanup?: boolean } = { triggerMeili: true },
): Promise<ApplyResult> {
  const start = Date.now();
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const knex = (container as unknown as { resolve: (k: string) => unknown }).resolve("__pg_connection__") as Knex;

  // 1. Batch UPDATE product.metadata.
  const productRows = Array.from(payloadMap.products.values()).map((p) => ({
    id: p.productId,
    metadata: p.metadata,
  }));
  logger.info(`[apply] writing ${productRows.length} product.metadata rows…`);
  const productsUpdated = await bulkReplaceMetadata(knex, "product", productRows);

  // 2. Batch UPDATE product_variant.metadata.
  const variantRows = Array.from(payloadMap.variants.values()).map((v) => ({
    id: v.variantId,
    metadata: v.metadata,
  }));
  logger.info(`[apply] writing ${variantRows.length} product_variant.metadata rows…`);
  const variantsUpdated = await bulkReplaceMetadata(knex, "product_variant", variantRows);

  // 3. Vendor link reconciliation (only for variants whose vendor target may have changed).
  logger.info(`[apply] reconciling ${vendorTargets.length} vendor links…`);
  const variantIds = vendorTargets.map((t) => t.variantId);
  const [existingLinks, catalog] = await Promise.all([
    loadExistingVendorLinks(container, variantIds),
    loadVendorCatalog(container),
  ]);
  const { plan, missing } = buildVendorLinkPlan({
    variantTargets: vendorTargets,
    existingLinks,
    catalogByListId: catalog,
  });
  const vendorLinks = await applyVendorLinkPlan(container, plan, missing);

  // 4. Cleanup legacy variant.metadata.qb_vendor_id / qb_vendor_name (one-shot across DB).
  let legacyCleanup: LegacyCleanupReport;
  if (opts.skipLegacyCleanup) {
    logger.info(`[apply] skipping legacy cleanup (skipLegacyCleanup=true)`);
    legacyCleanup = { variantsScanned: 0, variantsUpdated: 0 };
  } else {
    logger.info(`[apply] cleaning up legacy vendor keys…`);
    legacyCleanup = await cleanupLegacyVendorKeys(container, { dryRun: false });
  }

  // 5. Meili re-index for touched products.
  let meiliReindexed = 0;
  if (opts.triggerMeili) {
    const productIds = Array.from(payloadMap.products.keys());
    for (const v of payloadMap.variants.values()) {
      if (!productIds.includes(v.productId)) productIds.push(v.productId);
    }
    meiliReindexed = await triggerMeiliReindex(container, productIds);
  }

  return {
    productsUpdated,
    variantsUpdated,
    vendorLinks,
    legacyCleanup,
    meiliReindexed,
    elapsedMs: Date.now() - start,
  };
}

async function triggerMeiliReindex(container: MedusaContainer, productIds: string[]): Promise<number> {
  if (productIds.length === 0) return 0;
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  try {
    const eventBus = container.resolve(Modules.EVENT_BUS) as {
      emit: (events: Array<{ name: string; data: Record<string, unknown> }>) => Promise<void>;
    };
    const events = productIds.map((id) => ({ name: "product.updated", data: { id } }));
    const chunk = 200;
    for (let i = 0; i < events.length; i += chunk) {
      await eventBus.emit(events.slice(i, i + chunk));
    }
    return productIds.length;
  } catch (err) {
    logger.warn(`[apply] Meili re-index trigger failed — run yarn sync:meili manually: ${String((err as Error).message)}`);
    return 0;
  }
}

export function renderApplyResult(r: ApplyResult): void {
  console.log();
  console.log("═".repeat(80));
  console.log(`  APPLY COMPLETE in ${(r.elapsedMs / 1000).toFixed(1)}s`);
  console.log("═".repeat(80));
  console.log(`  products.metadata updated:       ${r.productsUpdated}`);
  console.log(`  variants.metadata updated:       ${r.variantsUpdated}`);
  console.log(`  vendor links created:            ${r.vendorLinks.linksCreated}`);
  console.log(`  vendor links dismissed:          ${r.vendorLinks.linksDismissed}`);
  console.log(`  vendors missing from catalog:    ${r.vendorLinks.skippedNoCatalogMatch}`);
  console.log(`  variants w/o vendor target:      ${r.vendorLinks.skippedNoTarget}`);
  console.log(`  legacy keys scanned:             ${r.legacyCleanup.variantsScanned}`);
  console.log(`  legacy keys cleaned:             ${r.legacyCleanup.variantsUpdated}`);
  console.log(`  products queued for Meili:       ${r.meiliReindexed}`);
  if (r.vendorLinks.missingVendors.length > 0) {
    console.log();
    console.log(`  Missing vendors (not in qb_vendor catalog):`);
    for (const m of r.vendorLinks.missingVendors.slice(0, 20)) {
      console.log(`    variant=${m.variantId}  qb_list_id=${m.qbListId}`);
    }
    if (r.vendorLinks.missingVendors.length > 20) {
      console.log(`    … and ${r.vendorLinks.missingVendors.length - 20} more`);
    }
    console.log(`  Run "Sync from QuickBooks" on /app/vendors then re-run apply to fix.`);
  }
  console.log("═".repeat(80));
  console.log();
}
