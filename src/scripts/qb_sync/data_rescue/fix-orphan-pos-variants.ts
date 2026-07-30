import { ExecArgs } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/utils";
import { syncInventoryWorkflow } from "../../../workflows/sync-inventory";
import { requireBridgeUrl } from "../../../lib/quickbooks/bridge-url";

/**
 * fix-orphan-pos-variants.ts
 *
 * POS Product Creation V2 left some variants partially wired:
 *   - variant has SKU + quickbooks_id in metadata
 *   - but missing: price_set (→ shows $0 in POS) AND/OR inventory_item link
 *     (→ shows "checking..." for availability)
 *
 * This script:
 *   1. Pulls QB SalesPrice for every variant with `metadata.quickbooks_id`
 *      via the documented working bulk endpoint
 *      (`/api/products/active-with-description`).
 *   2. For each variant missing a price_set → creates one + links.
 *   3. For each variant missing an inventory_item link → creates one + links.
 *   4. Triggers a Meili re-index so POS reflects the fix.
 *
 * Scope control:
 *   QB_SKUS=SKU1,SKU2,SKU3 npx medusa exec ... (limits to listed SKUs)
 *   (no env var)                              (scans ALL linked variants)
 *
 * Modes:
 *   DRY_RUN=true  → report only
 *   SYNC_MEILI=false → skip re-index
 */

const BRIDGE_URL = requireBridgeUrl();
const API_KEY =
  process.env.QB_API_KEY;
const POLL_INTERVAL_MS = 30_000;
const MAX_POLL_ATTEMPTS = 20;

interface QbItem {
  ListID?: string;
  Name?: string;
  FullName?: string;
  SalesPrice?: string | number;
}

interface VariantRow {
  id: string;
  sku: string | null;
  product_id?: string | null;
  quickbooks_id: string;
  has_price_set: boolean;
  has_inventory_link: boolean;
}

function priceToAmount(price: unknown): number {
  // NOTE: Medusa v2 in this project stores `price.amount` as DOLLARS (major
  // units), NOT cents. Existing items like MAX-12128BKAB have amount=218 for
  // a $218 price. Do NOT multiply by 100 here — that would store $31,800 for
  // a $318 QB SalesPrice.
  if (price === undefined || price === null || price === "") return 0;
  const n = typeof price === "string" ? parseFloat(price) : Number(price);
  if (isNaN(n)) return 0;
  // Round to 2-decimal precision in dollars.
  return Math.round(n * 100) / 100;
}

async function fetchQbBulk(log: (m: string) => void): Promise<QbItem[]> {
  const url = `${BRIDGE_URL}/api/products/active-with-description`;
  log(`📡 GET ${url}`);
  const initRes = await fetch(url, {
    headers: { "x-api-key": API_KEY, "bypass-tunnel-reminder": "true" },
  });
  if (!initRes.ok) {
    throw new Error(`Bridge → ${initRes.status} ${initRes.statusText}`);
  }
  const initJson = (await initRes.json()) as { operationId?: string };
  const operationId = initJson.operationId;
  if (!operationId) throw new Error("no operationId");
  log(`   op = ${operationId}`);

  for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    log(`⏳ Poll ${attempt}/${MAX_POLL_ATTEMPTS} ...`);
    const statusRes = await fetch(
      `${BRIDGE_URL}/api/sync/status/${operationId}`,
      { headers: { "x-api-key": API_KEY, "bypass-tunnel-reminder": "true" } }
    );
    if (!statusRes.ok) continue;
    const statusJson = (await statusRes.json()) as {
      operation?: {
        status?: string;
        error?: string;
        result?: {
          QBXML?: {
            QBXMLMsgsRs?: {
              ItemQueryRs?: { ItemInventoryRet?: unknown };
            };
          };
        };
      };
    };
    const op = statusJson.operation;
    if (!op) continue;
    if (op.status === "failed")
      throw new Error(`Bridge op failed: ${op.error}`);
    if (op.status === "completed") {
      const raw = op.result?.QBXML?.QBXMLMsgsRs?.ItemQueryRs?.ItemInventoryRet;
      if (!raw) return [];
      return Array.isArray(raw) ? (raw as QbItem[]) : [raw as QbItem];
    }
  }
  throw new Error("timeout");
}

export default async function fixOrphanPosVariants({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const query = container.resolve(ContainerRegistrationKeys.QUERY);
  const pricing = container.resolve(Modules.PRICING) as unknown as {
    createPriceSets: (input: {
      prices: { amount: number; currency_code: string; rules: object }[];
    }) => Promise<{ id: string }>;
  };
  const inventory = container.resolve(Modules.INVENTORY) as unknown as {
    createInventoryItems: (
      input: { sku: string; title: string; requires_shipping: boolean }
    ) => Promise<{ id: string }>;
  };
  const productModule = container.resolve(Modules.PRODUCT) as unknown as {
    updateProductVariants: (
      id: string,
      data: Record<string, unknown>
    ) => Promise<unknown>;
  };
  const remoteLink = container.resolve("remoteLink") as unknown as {
    create: (links: Record<string, unknown>) => Promise<void>;
  };

  const isDryRun = process.env.DRY_RUN === "true";
  const syncMeili = process.env.SYNC_MEILI !== "false";
  const skuFilter = (process.env.QB_SKUS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  logger.info("═".repeat(65));
  logger.info(
    `🩹 fix-orphan-pos-variants — ${isDryRun ? "DRY RUN" : "LIVE"}`
  );
  if (skuFilter.length) {
    logger.info(`   Scoped to SKUs: ${skuFilter.join(", ")}`);
  } else {
    logger.info(`   Scanning ALL variants with quickbooks_id metadata`);
  }
  logger.info("═".repeat(65));

  // 1. Load candidate variants
  const { data: allVariants } = await query.graph({
    entity: "variant",
    fields: [
      "id",
      "sku",
      "product.id",
      "metadata",
      "price_set.id",
      "inventory_items.inventory_item_id",
    ],
  });

  const candidates: VariantRow[] = [];
  for (const v of allVariants as Array<{
    id: string;
    sku: string | null;
    product?: { id?: string };
    metadata?: Record<string, unknown> | null;
    price_set?: { id?: string } | null;
    inventory_items?: Array<{ inventory_item_id?: string }> | null;
  }>) {
    const qbId = v.metadata?.quickbooks_id as string | undefined;
    if (!qbId) continue;
    if (skuFilter.length && (!v.sku || !skuFilter.includes(v.sku))) continue;
    const hasPriceSet = Boolean(v.price_set?.id);
    const hasInv = Boolean(
      v.inventory_items?.some((l) => l.inventory_item_id)
    );
    if (hasPriceSet && hasInv) continue; // fully wired
    candidates.push({
      id: v.id,
      sku: v.sku,
      product_id: v.product?.id ?? null,
      quickbooks_id: qbId,
      has_price_set: hasPriceSet,
      has_inventory_link: hasInv,
    });
  }

  logger.info(`\nFound ${candidates.length} orphan variants needing fixes:`);
  for (const c of candidates) {
    const needs: string[] = [];
    if (!c.has_price_set) needs.push("price");
    if (!c.has_inventory_link) needs.push("inventory");
    logger.info(
      `   • ${c.sku ?? "(no sku)"}   qb=${c.quickbooks_id}   needs: ${needs.join(", ")}`
    );
  }
  if (candidates.length === 0) {
    logger.info("Nothing to fix. Exiting.");
    return;
  }

  // 2. Fetch QB bulk for prices — only if ANY candidate needs a price
  const anyNeedsPrice = candidates.some((c) => !c.has_price_set);
  const qbByListId = new Map<string, QbItem>();
  if (anyNeedsPrice) {
    logger.info(`\n📡 Fetching QB catalog for prices...`);
    let qbItems: QbItem[];
    try {
      qbItems = await fetchQbBulk((m) => logger.info(m));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`❌ Bridge fetch failed: ${msg}`);
      return;
    }
    for (const it of qbItems) {
      if (it.ListID) qbByListId.set(it.ListID, it);
    }
    logger.info(`   Bulk fetched ${qbItems.length} items.`);
  }

  if (isDryRun) {
    logger.info(`\n📋 DRY RUN — showing planned actions:`);
    for (const c of candidates) {
      const qb = qbByListId.get(c.quickbooks_id);
      const amount = priceToAmount(qb?.SalesPrice);
      const actions: string[] = [];
      if (!c.has_price_set) {
        actions.push(
          amount > 0
            ? `create price_set $${(amount / 100).toFixed(2)}`
            : `SKIP price (QB SalesPrice missing)`
        );
      }
      if (!c.has_inventory_link) {
        actions.push(`create inventory_item + link`);
      }
      logger.info(`   • ${c.sku}: ${actions.join("; ")}`);
    }
    return;
  }

  // 3. Apply fixes
  let priceFixed = 0;
  let priceSkipped = 0;
  let invFixed = 0;
  const errors: string[] = [];

  for (const c of candidates) {
    // Price
    if (!c.has_price_set) {
      const qb = qbByListId.get(c.quickbooks_id);
      const amount = priceToAmount(qb?.SalesPrice);
      if (amount > 0) {
        try {
          const priceSet = await pricing.createPriceSets({
            prices: [{ amount, currency_code: "usd", rules: {} }],
          });
          await remoteLink.create({
            [Modules.PRODUCT]: { variant_id: c.id },
            [Modules.PRICING]: { price_set_id: priceSet.id },
          });
          logger.info(
            `✅ ${c.sku} price $${(amount / 100).toFixed(2)} (${priceSet.id})`
          );
          priceFixed++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`${c.sku} price: ${msg}`);
          logger.error(`❌ ${c.sku} price: ${msg}`);
        }
      } else {
        priceSkipped++;
        logger.warn(`⚠️  ${c.sku}: no SalesPrice in QB — price skipped`);
      }
    }

    // Inventory
    if (!c.has_inventory_link) {
      if (!c.sku) {
        errors.push(`${c.id} inventory: missing sku`);
        continue;
      }
      try {
        const invItem = await inventory.createInventoryItems({
          sku: c.sku,
          title: c.sku,
          requires_shipping: true,
        });
        await remoteLink.create({
          [Modules.PRODUCT]: { variant_id: c.id },
          [Modules.INVENTORY]: { inventory_item_id: invItem.id },
        });
        await productModule.updateProductVariants(c.id, {
          manage_inventory: true,
        });
        logger.info(`✅ ${c.sku} inventory_item ${invItem.id}`);
        invFixed++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${c.sku} inventory: ${msg}`);
        logger.error(`❌ ${c.sku} inventory: ${msg}`);
      }
    }
  }

  logger.info("\n" + "═".repeat(65));
  logger.info(`Prices created:      ${priceFixed}`);
  logger.info(`Prices skipped (no QB SalesPrice): ${priceSkipped}`);
  logger.info(`Inventory items created: ${invFixed}`);
  logger.info(`Errors: ${errors.length}`);
  if (errors.length) errors.forEach((e) => logger.info(`   • ${e}`));
  logger.info("═".repeat(65));

  // 4. Meili
  if (syncMeili && (priceFixed > 0 || invFixed > 0)) {
    logger.info(`\n🔎 Re-indexing MeiliSearch...`);
    try {
      const result = await syncInventoryWorkflow(container).run({ input: {} });
      const synced = (result as { result?: { synced?: number } }).result
        ?.synced;
      logger.info(`✅ Meili re-indexed ${synced ?? "?"} items`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`⚠️  Meili sync failed: ${msg}`);
    }
  }
}
