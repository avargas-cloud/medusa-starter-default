import { ExecArgs } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/utils";

/**
 * fix-missing-inventory-links.ts
 *
 * Creates inventory items and links them for product variants that:
 *   1. Have metadata.quickbooks_id set (i.e. real QB products)
 *   2. Do NOT have an inventory item linked
 *
 * Skips obvious service/non-inventory SKUs automatically.
 *
 * Usage:
 *   npx medusa exec src/scripts/qb_sync/data_rescue/fix-missing-inventory-links.ts          (dry-run)
 *   npx medusa exec src/scripts/qb_sync/data_rescue/fix-missing-inventory-links.ts -- --run  (apply)
 */

// SKU patterns that are services — no need for inventory tracking
const SERVICE_PREFIXES = [
  "Services:", "Notes:", "Charge:", "Project-",
  "Delete", "delete", "ELAB-",
];
const SERVICE_EXACT = new Set([
  "Turnkey", "Samples", "Office-Product", "Special Sale", "Prueba",
  "Unsatisfied Demand", "Uncollectible Debt", "WireConnector", "WireToWire",
  "Short-BiPin Socket", "3% Merchant Fee", "LiftRental", "H&P", "Programming",
  "INSTALL", "Lamp-Assembly", "Inspection-Request", "Services", "Notes",
  "Charge", "RetroFit-Plate", "Custom-Mirror", "Box",
]);

function isService(sku: string): boolean {
  if (SERVICE_EXACT.has(sku)) return true;
  return SERVICE_PREFIXES.some((p) => sku.startsWith(p));
}

export default async function fixMissingInventoryLinks({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const query = container.resolve(ContainerRegistrationKeys.QUERY);
  const inventoryService = container.resolve(Modules.INVENTORY);
  const remoteLink = container.resolve("remoteLink");

  const DRY_RUN = !process.argv.includes("--run");

  logger.info("=".repeat(65));
  logger.info("🔗 Fix Missing Inventory Links" + (DRY_RUN ? "  [DRY RUN]" : "  [LIVE]"));
  logger.info("=".repeat(65));

  // 1. Get all variants with their inventory item links
  const { data: variants } = await query.graph({
    entity: "product_variant",
    fields: [
      "id", "sku", "title", "manage_inventory",
      "metadata",
      "inventory_items.inventory_item_id",
    ],
  });

  // 2. Filter: has quickbooks_id but no inventory link and not a service
  const targets = variants.filter((v: any) => {
    if (!v.sku) return false;
    if (!v.metadata?.quickbooks_id) return false;
    if (v.inventory_items && v.inventory_items.length > 0) return false;
    if (isService(v.sku)) return false;
    return true;
  });

  // Services: have QB ID, no inventory item, and are service SKUs
  const serviceTargets = variants.filter((v: any) =>
    v.metadata?.quickbooks_id &&
    (!v.inventory_items || v.inventory_items.length === 0) &&
    v.sku && isService(v.sku) &&
    v.manage_inventory === true  // only fix those still set to true
  );

  logger.info(`\n📊 Variants with quickbooks_id:            ${variants.filter((v: any) => v.metadata?.quickbooks_id).length}`);
  logger.info(`   → Already have inventory item:           ${variants.filter((v: any) => v.metadata?.quickbooks_id && v.inventory_items?.length > 0).length}`);
  logger.info(`   → Services (set manage_inventory=false): ${serviceTargets.length}`);
  logger.info(`   → Physical products (create inv item):   ${targets.length}`);

  if (targets.length === 0 && serviceTargets.length === 0) {
    logger.info("\n✅ Nothing to fix.");
    return;
  }

  logger.info("\nPhysical products to fix:");
  targets.forEach((v: any) => logger.info(`   ${v.sku}  (QB: ${v.metadata.quickbooks_id})`));
  logger.info("\nServices to disable inventory:");
  serviceTargets.forEach((v: any) => logger.info(`   ${v.sku}`));

  if (DRY_RUN) {
    logger.info("\n💡 Dry-run complete. Run with -- --run to apply.");
    return;
  }

  const productService = container.resolve(Modules.PRODUCT);

  // ── Fix services: manage_inventory = false ──────────────────────────────────
  logger.info("\n🔧 Disabling inventory tracking for services...");
  let svcFixed = 0;
  for (const variant of serviceTargets as any[]) {
    try {
      await productService.updateProductVariants(variant.id, {
        manage_inventory: false,
      });
      svcFixed++;
      logger.info(`   ✅ ${variant.sku} → manage_inventory: false`);
    } catch (err: any) {
      logger.error(`   ❌ ${variant.sku}: ${err.message}`);
    }
  }

  // ── Fix physical products: create + link inventory item ─────────────────────
  logger.info("\n🔨 Creating inventory items and linking physical products...");
  let fixed = 0;
  let errors = 0;

  for (const variant of targets as any[]) {
    try {
      const inventoryItem = await inventoryService.createInventoryItems({
        sku: variant.sku,
        title: variant.title || variant.sku,
        requires_shipping: true,
      });

      await remoteLink.create({
        [Modules.PRODUCT]: { variant_id: variant.id },
        [Modules.INVENTORY]: { inventory_item_id: inventoryItem.id },
      });

      // Ensure manage_inventory is true
      await productService.updateProductVariants(variant.id, {
        manage_inventory: true,
      });

      fixed++;
      logger.info(`   ✅ ${variant.sku}  → ${inventoryItem.id}`);
    } catch (err: any) {
      errors++;
      logger.error(`   ❌ ${variant.sku}: ${err.message}`);
    }
  }

  logger.info("\n" + "=".repeat(65));
  logger.info(`Physical products — inventory created: ${fixed}   errors: ${errors}`);
  logger.info(`Services — manage_inventory disabled:  ${svcFixed}`);
  logger.info("=".repeat(65));
}
