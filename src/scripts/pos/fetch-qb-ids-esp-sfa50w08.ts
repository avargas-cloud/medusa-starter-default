import { ExecArgs } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/utils";
import { IProductModuleService } from "@medusajs/types";
import { fetchQbBulkItems } from "../qb_sync/lib/fetch-qb-bulk-items";

const TARGET_SKUS = ["ESP-SFA50W0830", "ESP-SFA50W0840", "ESP-SFA50W0860"];

export default async function fetchQbIdsEspSfa50w08({ container }: ExecArgs) {
  const isDryRun = process.env.DRY_RUN !== "false";
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const productModule: IProductModuleService = container.resolve(Modules.PRODUCT);

  logger.info("=".repeat(60));
  logger.info(isDryRun ? "DRY RUN — fetch QB IDs for ESP-SFA50W08 variants" : "LIVE — applying QB IDs to ESP-SFA50W08 variants");
  logger.info("=".repeat(60));

  logger.info("Fetching all active QB items via bridge...");
  const { items, totalFetched } = await fetchQbBulkItems({
    logger: (msg) => logger.info(msg),
  });
  logger.info(`Bridge returned ${totalFetched} items`);

  // Match our 3 SKUs (QB Name = SKU)
  const matches: Array<{ sku: string; listId: string; editSeq: string | undefined }> = [];
  for (const sku of TARGET_SKUS) {
    const item = items.find((i) => i.Name?.toUpperCase() === sku.toUpperCase());
    if (item) {
      matches.push({ sku, listId: item.ListID, editSeq: item.EditSequence });
      logger.info(`  ✅ ${sku} → ListID: ${item.ListID} (EditSeq: ${item.EditSequence})`);
    } else {
      logger.warn(`  ✗  ${sku} — NOT FOUND in QuickBooks`);
    }
  }

  if (matches.length === 0) {
    logger.warn("No matches found. Check that the SKUs exist in QB Desktop.");
    return;
  }

  if (isDryRun) {
    logger.info("\nDRY RUN — no DB writes. Run with DRY_RUN=false to apply.");
    return;
  }

  // Get variant IDs from Medusa
  logger.info("\nApplying quickbooks_id to variants...");
  for (const match of matches) {
    const [variants] = await productModule.listAndCountProductVariants(
      { sku: match.sku },
      { select: ["id", "sku", "metadata"] }
    );
    const variant = variants[0];
    if (!variant) {
      logger.warn(`  Variant ${match.sku} not found in Medusa — skipping`);
      continue;
    }

    await productModule.updateProductVariants(variant.id, {
      metadata: {
        ...(variant.metadata ?? {}),
        quickbooks_id: match.listId,
        qb_edit_sequence: match.editSeq,
      },
    });
    logger.info(`  ✅ ${match.sku} (${variant.id}) → quickbooks_id=${match.listId}`);
  }

  logger.info("\n" + "=".repeat(60));
  logger.info(`DONE — ${matches.length}/3 variants updated with QB IDs`);
  logger.info("=".repeat(60));
}
