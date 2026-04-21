#!/usr/bin/env tsx
/**
 * bootstrap-missing-qb-ids.ts
 *
 * Step 1 of the two-step mass-sync flow.
 *
 * Finds every Medusa variant that has NO quickbooks_id in metadata and tries
 * to match it to a QuickBooks item by SKU (variant.sku ↔ qbItem.Name, case-
 * insensitive).  On a match it writes `quickbooks_id` so that the canonical
 * mass-metadata-sync.ts can pick it up in Step 2 and fill the rest.
 *
 * Uses the same proven fetchQbBulkItems() lib as mass-metadata-sync so the
 * bridge endpoint, polling logic and JSON parsing are identical.
 *
 * SKUs that cannot be matched are listed in the report so you can review them
 * manually (service products, test products, renamed SKUs, etc.).
 *
 * Usage:
 *   # Dry-run (default — no writes):
 *   npx medusa exec ./src/scripts/qb_sync/core_jobs/bootstrap-missing-qb-ids.ts
 *
 *   # Apply:
 *   DRY_RUN=false npx medusa exec ./src/scripts/qb_sync/core_jobs/bootstrap-missing-qb-ids.ts
 */

import type { ExecArgs } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/utils";
import type { IProductModuleService } from "@medusajs/types";
import { fetchQbBulkItems } from "../lib/fetch-qb-bulk-items";

// SKUs we know have no QB item (services, test products) — skip silently.
const SKIP_SKU_PATTERNS = [
  /^test-product/i,
  /^Assembly-/i,
  /^Expedite-/i,
  /^Installation-/i,
  /^On-Site-/i,
  /^Service-/i,
];

function shouldSkip(sku: string): boolean {
  return SKIP_SKU_PATTERNS.some((p) => p.test(sku));
}

export default async function bootstrapMissingQbIds({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const query = container.resolve(ContainerRegistrationKeys.QUERY);
  const productModule: IProductModuleService = container.resolve(Modules.PRODUCT);

  const dryRun = process.env.DRY_RUN !== "false";

  logger.info("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  logger.info(`  Bootstrap Missing QB IDs${dryRun ? "  [DRY-RUN]" : "  [EXECUTE]"}`);
  logger.info("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  // 1. Load all Medusa variants without quickbooks_id.
  const { data: allVariants } = await query.graph({
    entity: "variant",
    fields: ["id", "sku", "metadata"],
  });

  const missing = (allVariants as { id: string; sku: string | null; metadata: Record<string, unknown> | null }[])
    .filter((v) => v.sku && !v.metadata?.quickbooks_id);

  logger.info(`Medusa variants without quickbooks_id: ${missing.length}`);

  const toProcess = missing.filter((v) => !shouldSkip(v.sku!));
  const skipped = missing.filter((v) => shouldSkip(v.sku!));
  logger.info(`  → ${skipped.length} skipped (service/test SKUs)`);
  logger.info(`  → ${toProcess.length} to match against QB\n`);

  if (toProcess.length === 0) {
    logger.info("✅  Nothing to bootstrap.");
    return;
  }

  // 2. Fetch all active QB items.
  const { items: qbItems, totalFetched } = await fetchQbBulkItems({
    logger: (msg) => logger.info(msg),
  });
  logger.info(`\nQB items fetched: ${totalFetched}\n`);

  // Index by Name (case-insensitive) and also by FullName last segment.
  const qbByName = new Map<string, (typeof qbItems)[0]>();
  for (const item of qbItems) {
    if (item.Name) qbByName.set(item.Name.trim().toUpperCase(), item);
    // Also index by FullName last segment (e.g. "Lighting:ESP-NFA30W0440" → "ESP-NFA30W0440")
    if (item.FullName) {
      const last = item.FullName.split(":").pop()?.trim().toUpperCase();
      if (last && !qbByName.has(last)) qbByName.set(last, item);
    }
  }

  // 3. Match.
  const matched: { variant: typeof toProcess[0]; qbItem: typeof qbItems[0] }[] = [];
  const unmatched: typeof toProcess = [];

  for (const variant of toProcess) {
    const key = variant.sku!.trim().toUpperCase();
    const qbItem = qbByName.get(key);
    if (qbItem) {
      matched.push({ variant, qbItem });
    } else {
      unmatched.push(variant);
    }
  }

  logger.info(`Matched    : ${matched.length}`);
  logger.info(`Unmatched  : ${unmatched.length}`);
  logger.info(`Skipped    : ${skipped.length}\n`);

  // 4. Report matches.
  if (matched.length > 0) {
    logger.info("── MATCHED (will set quickbooks_id) ──────────────────────");
    for (const { variant, qbItem } of matched) {
      logger.info(
        `  ${(variant.sku ?? "").padEnd(32)} → QB ListID: ${qbItem.ListID}  (${qbItem.itemType})`
      );
    }
    logger.info("");
  }

  if (unmatched.length > 0) {
    logger.info("── UNMATCHED (no QB item found by SKU) ───────────────────");
    for (const v of unmatched) {
      logger.info(`  ${v.sku}`);
    }
    logger.info("");
  }

  if (dryRun) {
    logger.info("⚠️   DRY-RUN — no writes. Re-run with DRY_RUN=false to apply.");
    logger.info("\nNext after applying:");
    logger.info("  DRY_RUN=false npx medusa exec ./src/scripts/qb_sync/core_jobs/mass-metadata-sync.ts");
    logger.info("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
    return;
  }

  // 5. Apply.
  let ok = 0;
  let failed = 0;

  for (const { variant, qbItem } of matched) {
    try {
      await productModule.updateProductVariants(variant.id, {
        metadata: {
          ...(variant.metadata ?? {}),
          quickbooks_id: qbItem.ListID,
        },
      });
      ok++;
      if (ok % 25 === 0) logger.info(`  ...updated ${ok}/${matched.length}`);
    } catch (err) {
      failed++;
      logger.error(`  ❌ ${variant.sku}: ${(err as Error).message}`);
    }
  }

  logger.info("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  logger.info(`✅  Set quickbooks_id on ${ok} variant(s).`);
  if (failed > 0) logger.warn(`❌  ${failed} failed — check logs above.`);
  logger.info("\nRun Step 2 now:");
  logger.info("  DRY_RUN=false npx medusa exec ./src/scripts/qb_sync/core_jobs/mass-metadata-sync.ts");
  logger.info("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
}
