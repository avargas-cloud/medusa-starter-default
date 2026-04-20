#!/usr/bin/env tsx
/**
 * mass-metadata-sync.ts
 *
 * Bulk syncs metadata from QuickBooks Desktop into Medusa for every active item.
 * Dry-run by default. Writes a JSON plan to /tmp and prints a grouped report.
 *
 * Usage:
 *   # Dry run (default — no writes, just report + JSON plan):
 *   npx medusa exec ./src/scripts/qb_sync/core_jobs/mass-metadata-sync.ts
 *
 *   # Apply (live writes — snapshot first, then updates):
 *   DRY_RUN=false npx medusa exec ./src/scripts/qb_sync/core_jobs/mass-metadata-sync.ts
 */
import type { ExecArgs } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/utils";
import * as fs from "fs";
import * as path from "path";
import {
  toSnapshot,
  type MedusaProductView,
  type MedusaVariantView,
  type QbItemRaw,
} from "../../../lib/quickbooks/bulk-item-types";
import { fetchQbBulkItems } from "../lib/fetch-qb-bulk-items";
import {
  classifyMetadataDiff,
  computeProposedDefaults,
  type Classification,
  type ProposedProductDefaults,
} from "../lib/classify-metadata-diff";
import {
  emptyPayloadMap,
  mergeProductDiff,
  mergeVariantDiff,
} from "../lib/build-update-payload";
import {
  renderDryRunReport,
  type DryRunPlan,
  type MissingEntry,
  type OrphanEntry,
  type PerVariantEntry,
} from "../lib/render-dry-run-report";
import {
  applyMetadataSync,
  renderApplyResult,
  type VendorTarget,
} from "../lib/apply-metadata-sync";
import { buildSnapshot, writeSnapshot } from "../lib/snapshot-before-apply";
import { loadExistingVendorLinks } from "../lib/resolve-vendor-links";

type QueryVariantRow = {
  id: string;
  sku: string | null;
  metadata: Record<string, unknown> | null;
  product: {
    id: string;
    metadata: Record<string, unknown> | null;
  } | null;
};

function toVariantView(row: QueryVariantRow): MedusaVariantView | null {
  if (!row.product?.id) return null;
  return {
    id: row.id,
    sku: row.sku,
    productId: row.product.id,
    metadata: row.metadata,
  };
}

function zeroClassificationTotals(): Record<Classification, number> {
  return {
    NO_CHANGE: 0,
    VARIANT_UPDATE: 0,
    PRODUCT_UPDATE: 0,
    BOTH_UPDATE: 0,
    OVERRIDE_CLEARED: 0,
    MISSING_IN_MEDUSA: 0,
    ORPHAN_IN_MEDUSA: 0,
  };
}

export default async function massMetadataSync({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const query = container.resolve(ContainerRegistrationKeys.QUERY);

  const dryRun = process.env.DRY_RUN !== "false";
  logger.info(`[mass-sync] Mode: ${dryRun ? "DRY_RUN" : "APPLY (Phase 5)"}`);

  // 1. Fetch QB items via bridge.
  const { items, operationId, totalFetched } = await fetchQbBulkItems({
    logger: (msg) => logger.info(msg),
  });

  // 2. Index QB by ListID.
  const qbByListId = new Map<string, QbItemRaw>();
  for (const item of items) {
    qbByListId.set(item.ListID, item);
  }

  // 3. Load Medusa variants that have a quickbooks_id.
  logger.info("[mass-sync] loading Medusa variants with quickbooks_id…");
  const { data: rawVariants } = await query.graph({
    entity: "variant",
    fields: ["id", "sku", "metadata", "product.id", "product.metadata"],
  });
  const medusaAll = (rawVariants as QueryVariantRow[])
    .map(toVariantView)
    .filter((v): v is MedusaVariantView => v !== null);

  const medusaWithQbId = medusaAll.filter(
    (v) => typeof v.metadata?.quickbooks_id === "string" && (v.metadata.quickbooks_id as string).length > 0,
  );
  logger.info(
    `[mass-sync] medusa variants total=${medusaAll.length}, with quickbooks_id=${medusaWithQbId.length}`,
  );

  // 4. Index Medusa by ListID and group by product.
  const medusaByListId = new Map<string, MedusaVariantView>();
  const productById = new Map<string, MedusaProductView>();
  const variantsByProduct = new Map<string, MedusaVariantView[]>();
  for (const v of medusaWithQbId) {
    const listId = v.metadata?.quickbooks_id as string;
    medusaByListId.set(listId, v);
    const list = variantsByProduct.get(v.productId) ?? [];
    list.push(v);
    variantsByProduct.set(v.productId, list);
    if (!productById.has(v.productId)) {
      const full = (rawVariants as QueryVariantRow[]).find((r) => r.product?.id === v.productId);
      if (full?.product) {
        productById.set(v.productId, { id: full.product.id, metadata: full.product.metadata });
      }
    }
  }

  // 5. Build driver map: first variant by variant.id ASC per product.
  const driverVariantId = new Map<string, string>();
  for (const [productId, siblings] of variantsByProduct.entries()) {
    siblings.sort((a, b) => a.id.localeCompare(b.id));
    driverVariantId.set(productId, siblings[0].id);
  }

  // 6. TWO-PASS classification.
  // Pass A: classify drivers first → compute proposed product defaults.
  // Pass B: classify siblings using the driver's proposed defaults → overrides
  //         are only emitted when sibling truly differs from the NEW default.
  const entries: PerVariantEntry[] = [];
  const totals = zeroClassificationTotals();
  const payloadMap = emptyPayloadMap();
  const proposedByProduct = new Map<string, ProposedProductDefaults>();

  const runOne = (variant: MedusaVariantView, isDriver: boolean): void => {
    const listId = variant.metadata?.quickbooks_id as string;
    const qbRaw = qbByListId.get(listId);
    const product = productById.get(variant.productId);
    if (!product || !qbRaw) return;
    const qb = toSnapshot(qbRaw);
    if (isDriver) {
      proposedByProduct.set(variant.productId, computeProposedDefaults(qb, product));
    }
    const result = classifyMetadataDiff({
      qb,
      variant,
      product,
      isDriver,
      proposedDefaults: isDriver ? undefined : proposedByProduct.get(variant.productId),
    });
    totals[result.classification] += 1;
    entries.push({
      listId,
      variantId: variant.id,
      productId: variant.productId,
      sku: qb.sku || variant.sku || "(no sku)",
      classification: result.classification,
      isDriver,
      productDiffs: result.productDiffs,
      variantDiffs: result.variantDiffs,
    });
    if (result.productDiffs.length > 0) {
      mergeProductDiff(payloadMap, product, result.productDiffs);
    }
    if (result.variantDiffs.length > 0) {
      mergeVariantDiff(payloadMap, variant, result.variantDiffs);
    }
  };

  // Pass A: drivers
  for (const variant of medusaWithQbId) {
    if (driverVariantId.get(variant.productId) !== variant.id) continue;
    runOne(variant, true);
  }
  // Pass B: siblings
  for (const variant of medusaWithQbId) {
    if (driverVariantId.get(variant.productId) === variant.id) continue;
    runOne(variant, false);
  }

  // 7. Orphans.
  const orphans: OrphanEntry[] = [];
  for (const variant of medusaWithQbId) {
    const listId = variant.metadata?.quickbooks_id as string;
    if (qbByListId.has(listId)) continue;
    orphans.push({ variantId: variant.id, productId: variant.productId, sku: variant.sku, listId });
    totals.ORPHAN_IN_MEDUSA += 1;
  }

  // 8. Missing.
  const medusaListIds = new Set(medusaByListId.keys());
  const missing: MissingEntry[] = [];
  for (const [listId, raw] of qbByListId.entries()) {
    if (medusaListIds.has(listId)) continue;
    const sku = (typeof raw.FullName === "string" && raw.FullName) || (typeof raw.Name === "string" && raw.Name) || "";
    missing.push({ listId, sku, itemType: raw.itemType });
    totals.MISSING_IN_MEDUSA += 1;
  }

  const matched = entries.length;
  const productsTouched = payloadMap.products.size;
  const variantsTouched = payloadMap.variants.size;

  // 9. Build plan + render + persist.
  const plan: DryRunPlan = {
    generatedAt: new Date().toISOString(),
    bridgeOperationId: operationId,
    totals: {
      qbItemsFetched: totalFetched,
      medusaVariantsWithQbId: medusaWithQbId.length,
      matched,
      byClassification: totals,
      orphans: orphans.length,
      missing: missing.length,
      productsTouched,
      variantsTouched,
    },
    entries,
    orphans,
    missing,
  };

  const outDir = "/tmp";
  const outFile = path.join(outDir, `qb-mass-sync-plan-${Date.now()}.json`);
  fs.writeFileSync(outFile, JSON.stringify(plan, null, 2));
  logger.info(`[mass-sync] plan written to ${outFile}`);

  renderDryRunReport(plan);

  if (dryRun) {
    logger.info("[mass-sync] DRY_RUN=true — no writes performed. Re-run with DRY_RUN=false to apply.");
    return;
  }

  // ── APPLY MODE ──────────────────────────────────────────────────────────
  // Optional subset mode: APPLY_ONLY_PRODUCT_IDS filters payload to named products.
  // Optional SKIP_LEGACY_CLEANUP defers the global qb_vendor_id/qb_vendor_name sweep.
  const onlyProducts = (process.env.APPLY_ONLY_PRODUCT_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const skipLegacy = process.env.SKIP_LEGACY_CLEANUP === "true";
  if (onlyProducts.length > 0) {
    const keepProducts = new Set(onlyProducts);
    for (const id of Array.from(payloadMap.products.keys())) {
      if (!keepProducts.has(id)) payloadMap.products.delete(id);
    }
    for (const [id, v] of Array.from(payloadMap.variants.entries())) {
      if (!keepProducts.has(v.productId)) payloadMap.variants.delete(id);
    }
    logger.info(
      `[mass-sync] APPLY subset: ${payloadMap.products.size} products / ${payloadMap.variants.size} variants (filtered by APPLY_ONLY_PRODUCT_IDS)`,
    );
  }
  logger.info("[mass-sync] APPLY starting — writing snapshot then applying…");

  // Build vendorTargets: per variant, the qb_list_id it should be linked to.
  // Priority: variant override (from final metadata) > product default (from final metadata).
  const productFinal = new Map<string, Record<string, unknown>>();
  for (const p of payloadMap.products.values()) {
    productFinal.set(p.productId, p.metadata);
  }
  for (const [id, p] of productById.entries()) {
    if (!productFinal.has(id)) productFinal.set(id, p.metadata ?? {});
  }
  const variantFinal = new Map<string, Record<string, unknown>>();
  for (const v of payloadMap.variants.values()) {
    variantFinal.set(v.variantId, v.metadata);
  }
  for (const v of medusaWithQbId) {
    if (!variantFinal.has(v.id)) variantFinal.set(v.id, v.metadata ?? {});
  }

  const allowProductIds =
    onlyProducts.length > 0 ? new Set(onlyProducts) : null;
  const vendorTargets: VendorTarget[] = [];
  for (const entry of entries) {
    if (allowProductIds && !allowProductIds.has(entry.productId)) continue;
    const variantMeta = variantFinal.get(entry.variantId) ?? {};
    const productMeta = productFinal.get(entry.productId) ?? {};
    const override = variantMeta.qb_override_vendor_qb_id;
    const pDefault = productMeta.qb_vendor_list_id;
    const target =
      typeof override === "string" && override.length > 0
        ? override
        : typeof pDefault === "string" && pDefault.length > 0
          ? pDefault
          : null;
    vendorTargets.push({ variantId: entry.variantId, targetQbListId: target });
  }

  // Snapshot BEFORE writes.
  const variantById = new Map<string, { id: string; productId: string; metadata: Record<string, unknown> | null }>();
  for (const v of medusaWithQbId) {
    variantById.set(v.id, { id: v.id, productId: v.productId, metadata: v.metadata });
  }
  const existingLinks = await loadExistingVendorLinks(
    container,
    entries.map((e) => e.variantId),
  );
  const snapshot = buildSnapshot({
    payloadMap,
    variantById,
    productById,
    variantVendorLinks: existingLinks,
    planFile: outFile,
  });
  const snapshotFile = writeSnapshot(snapshot);
  logger.info(`[mass-sync] snapshot written to ${snapshotFile}`);

  const applyResult = await applyMetadataSync(container, payloadMap, vendorTargets, {
    triggerMeili: true,
    skipLegacyCleanup: skipLegacy,
  });
  renderApplyResult(applyResult);

  logger.info(`[mass-sync] apply complete. Plan: ${outFile}  Snapshot: ${snapshotFile}`);
}
