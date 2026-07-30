import { ExecArgs } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/utils";
import { IProductModuleService } from "@medusajs/types";
import { updateProductsWorkflow } from "@medusajs/medusa/core-flows";
import { QUICKBOOKS_CATALOG_MODULE } from "../../../modules/quickbooks-catalog";
import { requireBridgeUrl } from "../../../lib/quickbooks/bridge-url";

/**
 * Restores the 2 deleted variants (ESP-NFA30W0430, ESP-NFA30W0460) on product
 * prod_01KK5CFJVG1BJVPQKR0H12EDVN (ESP-NFA30W04), and updates the MPN on the
 * existing ESP-NFA30W0440 variant. Data fetched live from QB Desktop.
 *
 * Usage:
 *   npx medusa exec ./src/scripts/qb_sync/core_jobs/restore-nfa30w04-variants.ts
 *   DRY_RUN=true npx medusa exec ...
 */

const BRIDGE_URL = requireBridgeUrl();
const API_KEY = process.env.QB_API_KEY;
const POLL_INTERVAL_MS = 30_000;
const MAX_POLL_ATTEMPTS = 20;

const PRODUCT_ID = "prod_01KK5CFJVG1BJVPQKR0H12EDVN";
const QB_VENDOR_ID = "qbvnd_01KPGGRPH0DGCBJKMP85HK83DT";

const VARIANTS_CONFIG = [
  {
    sku: "ESP-NFA30W0430",
    title: "3000K",
    optionValue: "3000K",
    inventoryItemId: "iitem_01KK5FCTNADSJ9HBXM17XTFHKT",
    variantRank: 0,
    action: "create" as const,
  },
  {
    sku: "ESP-NFA30W0440",
    title: "4000K",
    optionValue: "4000K",
    inventoryItemId: "iitem_01KK5FCPHXWY9T4HR54EDDW19F",
    variantRank: 1,
    existingVariantId: "variant_01KPS2M42JPECPFWTTE3JGHKN1",
    action: "update" as const,
  },
  {
    sku: "ESP-NFA30W0460",
    title: "6000K",
    optionValue: "6000K",
    inventoryItemId: "iitem_01KK5FCMGJHH7KY40VK04X058D",
    variantRank: 2,
    action: "create" as const,
  },
] as const;

interface QbItem {
  ListID?: string;
  Name?: string;
  FullName?: string;
  ManufacturerPartNumber?: string;
  SalesDesc?: string;
  SalesPrice?: string | number;
  [key: string]: unknown;
}

function priceToAmount(price: unknown): number {
  if (price === undefined || price === null || price === "") return 0;
  const n = typeof price === "string" ? parseFloat(price) : Number(price);
  if (isNaN(n)) return 0;
  return Math.round(n * 100) / 100;
}

async function fetchQbItems(log: (m: string) => void): Promise<QbItem[]> {
  const endpoint = `${BRIDGE_URL}/api/products/active-with-description`;
  log(`📡 GET ${endpoint}`);
  const res = await fetch(endpoint, {
    headers: { "x-api-key": API_KEY, "bypass-tunnel-reminder": "true" },
  });
  if (!res.ok) throw new Error(`Bridge ${res.status} ${res.statusText}`);
  const { operationId } = (await res.json()) as { operationId?: string };
  if (!operationId) throw new Error("Bridge returned no operationId");
  log(`   operationId = ${operationId}`);

  for (let i = 1; i <= MAX_POLL_ATTEMPTS; i++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    log(`⏳ Poll ${i}/${MAX_POLL_ATTEMPTS}...`);
    const statusRes = await fetch(
      `${BRIDGE_URL}/api/sync/status/${operationId}`,
      { headers: { "x-api-key": API_KEY, "bypass-tunnel-reminder": "true" } }
    );
    if (!statusRes.ok) { log(`   HTTP ${statusRes.status} — retry`); continue; }
    const json = (await statusRes.json()) as {
      operation?: {
        status?: string;
        error?: string;
        result?: { QBXML?: { QBXMLMsgsRs?: { ItemQueryRs?: { ItemInventoryRet?: unknown } } } };
      };
    };
    const op = json.operation;
    if (!op) continue;
    if (op.status === "completed") {
      const raw = op.result?.QBXML?.QBXMLMsgsRs?.ItemQueryRs?.ItemInventoryRet;
      if (!raw) throw new Error("Operation completed but no ItemInventoryRet");
      const items = Array.isArray(raw) ? (raw as QbItem[]) : [raw as QbItem];
      log(`✅ ${items.length} QB items returned`);
      return items;
    }
    if (op.status === "failed")
      throw new Error(`Operation failed: ${op.error ?? "unknown"}`);
  }
  throw new Error(`Bridge timed out after ${MAX_POLL_ATTEMPTS} polls`);
}

export default async function ({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const isDryRun = process.env.DRY_RUN === "true";

  const productModule = container.resolve(Modules.PRODUCT) as IProductModuleService;
  const link = container.resolve(ContainerRegistrationKeys.LINK);
  const pricing = container.resolve(Modules.PRICING) as unknown as {
    createPriceSets: (input: {
      prices: { amount: number; currency_code: string; rules: object }[];
    }) => Promise<{ id: string }>;
  };

  logger.info("═".repeat(65));
  logger.info("🔧 Restore ESP-NFA30W04 Variants");
  logger.info(`   Mode: ${isDryRun ? "DRY RUN" : "LIVE"}`);
  logger.info("═".repeat(65));

  // 1. Fetch QB data
  let qbItems: QbItem[];
  try {
    qbItems = await fetchQbItems((m) => logger.info(m));
  } catch (err) {
    logger.error(`❌ QB fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // 2. Match each SKU in QB
  const skuMap = new Map<string, QbItem>();
  for (const cfg of VARIANTS_CONFIG) {
    const match = qbItems.find(
      (it) => (it.Name ?? "").trim().toUpperCase() === cfg.sku.toUpperCase()
    );
    if (match) {
      skuMap.set(cfg.sku, match);
      logger.info(
        `✅ QB: ${cfg.sku} → ListID=${match.ListID ?? "(none)"}  MPN=${match.ManufacturerPartNumber ?? "(none)"}  Price=$${match.SalesPrice ?? "?"}`
      );
    } else {
      logger.warn(`⚠️  QB: ${cfg.sku} NOT found`);
    }
  }

  if (isDryRun) {
    logger.info("\n📋 DRY RUN — no DB changes. Re-run without DRY_RUN=true.");
    return;
  }

  // 3. Update ESP-NFA30W0440 MPN
  const cfg0440 = VARIANTS_CONFIG.find((c) => c.sku === "ESP-NFA30W0440")!;
  const qb0440 = skuMap.get("ESP-NFA30W0440");
  if (qb0440) {
    const mpn = qb0440.ManufacturerPartNumber ?? null;
    const amount = priceToAmount(qb0440.SalesPrice);
    logger.info(`\n🔄 Updating ESP-NFA30W0440 (${cfg0440.existingVariantId})`);
    logger.info(`   MPN: ${mpn ?? "(none)"}  Price: $${amount}`);
    await updateProductsWorkflow(container).run({
      input: {
        products: [{
          id: PRODUCT_ID,
          variants: [{
            id: cfg0440.existingVariantId,
            ...(mpn ? { mid_code: mpn } : {}),
            metadata: {
              quickbooks_id: qb0440.ListID ?? null,
              qb_sku: cfg0440.sku,
              ...(mpn ? { mpn } : {}),
            },
            ...(amount > 0 ? { prices: [{ currency_code: "usd", amount }] } : {}),
          }],
        }],
      },
    });
    logger.info(`   ✅ Updated`);
  }

  // 4. Create the 2 missing variants
  for (const cfg of VARIANTS_CONFIG.filter((c) => c.action === "create")) {
    const qbItem = skuMap.get(cfg.sku);
    const amount = qbItem ? priceToAmount(qbItem.SalesPrice) : 0;
    const mpn = qbItem?.ManufacturerPartNumber ?? null;
    const listId = qbItem?.ListID ?? null;

    logger.info(`\n➕ Creating variant ${cfg.sku} (${cfg.title})`);

    // manage_inventory: false so Medusa doesn't auto-create an inventory item
    // (we'll link the existing one manually)
    const [created] = await productModule.createProductVariants([
      {
        product_id: PRODUCT_ID,
        title: cfg.title,
        sku: cfg.sku,
        variant_rank: cfg.variantRank,
        manage_inventory: false,
        allow_backorder: false,
        ...(mpn ? { mid_code: mpn } : {}),
        options: { "Color Options": cfg.optionValue },
        metadata: {
          quickbooks_id: listId,
          qb_sku: cfg.sku,
          ...(mpn ? { mpn } : {}),
          sales_description: qbItem?.SalesDesc ?? null,
        },
      } as Parameters<typeof productModule.createProductVariants>[0][0],
    ]);
    const variantId = (created as { id: string }).id;
    logger.info(`   ✅ Variant created: ${variantId}`);

    // 4a. Re-enable manage_inventory
    await productModule.updateProductVariants(variantId, {
      manage_inventory: true,
    });

    // 4b. Link to existing inventory item
    await link.create({
      [Modules.PRODUCT]: { variant_id: variantId },
      [Modules.INVENTORY]: { inventory_item_id: cfg.inventoryItemId },
    });
    logger.info(`   ✅ Linked to inventory item ${cfg.inventoryItemId}`);

    // 4c. Create and link price
    if (amount > 0) {
      const priceSet = await pricing.createPriceSets({
        prices: [{ amount, currency_code: "usd", rules: {} }],
      });
      await link.create({
        [Modules.PRODUCT]: { variant_id: variantId },
        [Modules.PRICING]: { price_set_id: priceSet.id },
      });
      logger.info(`   ✅ Price set ${priceSet.id} linked ($${amount})`);
    }

    // 4d. Link to QB vendor product
    try {
      await link.create({
        [QUICKBOOKS_CATALOG_MODULE]: { qb_vendor_id: QB_VENDOR_ID },
        [Modules.PRODUCT]: { product_variant_id: variantId },
      });
      logger.info(`   ✅ QB vendor link created`);
    } catch (err) {
      logger.warn(`   ⚠️  QB vendor link failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  logger.info("\n" + "═".repeat(65));
  logger.info("🎉 Done.");
  logger.info(`   Admin: /app/products/${PRODUCT_ID}`);
  logger.info("═".repeat(65));
}
