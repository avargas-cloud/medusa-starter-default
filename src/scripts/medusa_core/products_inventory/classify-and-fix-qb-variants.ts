import { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/utils";

/**
 * Classify variants linked to QuickBooks that are missing an inventory item,
 * and apply the correct fix per category:
 *
 *   PHYSICAL     → create inventory item + link + manage_inventory=true
 *   SERVICE      → manage_inventory=false, no inventory item created
 *   PLACEHOLDER  → report only (probably needs manual QB unlink / deletion)
 *   AMBIGUOUS    → report only
 *
 * Flip DRY_RUN to false to apply.
 */

const DRY_RUN = true;

type Category = "PHYSICAL" | "SERVICE" | "PLACEHOLDER" | "AMBIGUOUS";

const SERVICE_RE =
  /^(ELAB-|Services?(:|$)|Notes?(:|$)|Charge(:|$)|Project-(LED|Automation|Commercial)|INSTALL$|H&P$|Programming$|LiftRental$|Turnkey$|Inspection-Request$|Special Sale$|Uncollectible Debt$|Unsatisfied Demand$|3% Merchant Fee$)/i;

const PLACEHOLDER_RE = /^(Delete\d*|delete\d*|Prueba)$/i;

// Vendor prefixes + generic physical product tokens.
const PHYSICAL_RE =
  /^(SUN-|NX-|LUM-|MAX-|ET2-|GL-|LUX-|ECTSK-|PS12V|EMSH|LT\d|C\d|5NNG2|E89885|MNPT50|5228332u|200102|051141253817|Box$|Samples$|Office-Product$|Lamp-Assembly$|WireConnector$|WireToWire$|Custom-Mirror$|RetroFit-Plate$|Short-BiPin Socket$)/i;

function classify(sku: string): Category {
  if (PLACEHOLDER_RE.test(sku)) return "PLACEHOLDER";
  if (SERVICE_RE.test(sku)) return "SERVICE";
  if (PHYSICAL_RE.test(sku)) return "PHYSICAL";
  return "AMBIGUOUS";
}

interface VariantRow {
  id: string;
  sku: string | null;
  title: string | null;
  manage_inventory: boolean | null;
  hasInventoryItem: boolean;
  qbId: string | null;
}

interface Report {
  dryRun: boolean;
  totalScanned: number;
  totalWithoutInventoryItem: number;
  counts: Record<Category, number>;
  applied: {
    inventoryItemsCreated: number;
    manageInventoryDisabled: number;
  };
  groups: Record<Category, Array<{ sku: string; variantId: string; action: string }>>;
  errors: Array<{ sku: string; variantId: string; error: string }>;
}

export default async function classifyAndFixQbVariants({
  container,
}: {
  container: MedusaContainer;
}) {
  console.log(
    `🔎 Classifying QB-linked variants missing inventory item (DRY_RUN=${DRY_RUN})\n`
  );

  const query = container.resolve(ContainerRegistrationKeys.QUERY);
  const inventoryService = container.resolve(Modules.INVENTORY);
  const productService = container.resolve(Modules.PRODUCT);
  const remoteLink = container.resolve("remoteLink");

  const { data: variants } = await query.graph({
    entity: "product_variant",
    fields: [
      "id",
      "sku",
      "title",
      "manage_inventory",
      "metadata",
      "inventory_items.inventory_item_id",
    ],
  });

  const targets: VariantRow[] = variants
    .filter((v: any) => v.metadata?.quickbooks_id)
    .map((v: any) => ({
      id: v.id,
      sku: v.sku,
      title: v.title,
      manage_inventory: v.manage_inventory,
      hasInventoryItem: !!v.inventory_items?.[0]?.inventory_item_id,
      qbId: v.metadata?.quickbooks_id || null,
    }))
    .filter((v: VariantRow) => !v.hasInventoryItem);

  const report: Report = {
    dryRun: DRY_RUN,
    totalScanned: variants.length,
    totalWithoutInventoryItem: targets.length,
    counts: { PHYSICAL: 0, SERVICE: 0, PLACEHOLDER: 0, AMBIGUOUS: 0 },
    applied: { inventoryItemsCreated: 0, manageInventoryDisabled: 0 },
    groups: { PHYSICAL: [], SERVICE: [], PLACEHOLDER: [], AMBIGUOUS: [] },
    errors: [],
  };

  console.log(
    `📊 ${targets.length} QB-linked variants without inventory item (of ${variants.length} total)\n`
  );

  for (const v of targets) {
    const sku = v.sku || `NO-SKU-${v.id}`;
    const category = classify(sku);
    report.counts[category]++;

    try {
      if (category === "PHYSICAL") {
        if (!DRY_RUN) {
          const inventoryItem = await inventoryService.createInventoryItems({
            sku,
          });
          await remoteLink.create({
            [Modules.PRODUCT]: { variant_id: v.id },
            [Modules.INVENTORY]: { inventory_item_id: inventoryItem.id },
          });
          await productService.updateProductVariants(v.id, {
            manage_inventory: true,
          });
          report.applied.inventoryItemsCreated++;
        }
        report.groups.PHYSICAL.push({
          sku,
          variantId: v.id,
          action: "create inventory item + link + manage_inventory=true",
        });
        console.log(`✅ PHYSICAL   ${sku}`);
      } else if (category === "SERVICE") {
        if (!DRY_RUN && v.manage_inventory !== false) {
          await productService.updateProductVariants(v.id, {
            manage_inventory: false,
          });
          report.applied.manageInventoryDisabled++;
        }
        report.groups.SERVICE.push({
          sku,
          variantId: v.id,
          action: "set manage_inventory=false (no inventory item)",
        });
        console.log(`🛠️  SERVICE    ${sku}`);
      } else if (category === "PLACEHOLDER") {
        report.groups.PLACEHOLDER.push({
          sku,
          variantId: v.id,
          action: "MANUAL REVIEW — likely unlink from QB and delete",
        });
        console.log(`🗑️  PLACEHOLDER ${sku}`);
      } else {
        report.groups.AMBIGUOUS.push({
          sku,
          variantId: v.id,
          action: "MANUAL REVIEW — classification unclear",
        });
        console.log(`❓ AMBIGUOUS  ${sku}`);
      }
    } catch (error: any) {
      console.error(`❌ ${sku}: ${error.message}`);
      report.errors.push({
        sku,
        variantId: v.id,
        error: error.message,
      });
    }
  }

  console.log(`\n${"=".repeat(70)}`);
  console.log(DRY_RUN ? "📋 DRY RUN — CLASSIFICATION PLAN" : "✅ APPLIED");
  console.log("=".repeat(70));
  console.log(`Total variants scanned:            ${report.totalScanned}`);
  console.log(`QB-linked w/o inventory item:      ${report.totalWithoutInventoryItem}`);
  console.log(`  PHYSICAL    (create inv item):   ${report.counts.PHYSICAL}`);
  console.log(`  SERVICE     (disable manage):    ${report.counts.SERVICE}`);
  console.log(`  PLACEHOLDER (manual review):     ${report.counts.PLACEHOLDER}`);
  console.log(`  AMBIGUOUS   (manual review):     ${report.counts.AMBIGUOUS}`);
  if (!DRY_RUN) {
    console.log(
      `\nInventory items created:           ${report.applied.inventoryItemsCreated}`
    );
    console.log(
      `manage_inventory disabled:         ${report.applied.manageInventoryDisabled}`
    );
  }
  console.log(`Errors:                            ${report.errors.length}`);

  if (report.groups.AMBIGUOUS.length > 0) {
    console.log(`\n❓ AMBIGUOUS SKUs (need your review):`);
    for (const r of report.groups.AMBIGUOUS) {
      console.log(`   ${r.sku}  (variantId=${r.variantId})`);
    }
  }
  if (report.groups.PLACEHOLDER.length > 0) {
    console.log(`\n🗑️  PLACEHOLDER SKUs:`);
    for (const r of report.groups.PLACEHOLDER) {
      console.log(`   ${r.sku}  (variantId=${r.variantId})`);
    }
  }
  if (report.errors.length > 0) {
    console.log(`\n❌ ERRORS:`);
    for (const e of report.errors) {
      console.log(`   ${e.sku}: ${e.error}`);
    }
  }

  const fs = await import("fs/promises");
  const reportPath = "./classify-qb-variants-report.json";
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(`\n💾 Report saved to: ${reportPath}`);

  if (DRY_RUN) {
    console.log(
      `\n⚠️  DRY RUN only. Flip DRY_RUN=false in the script to apply.`
    );
  }

  return report;
}
