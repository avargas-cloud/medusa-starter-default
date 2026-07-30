import { ExecArgs } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/utils";
import { IProductModuleService } from "@medusajs/types";
import { updateProductsWorkflow } from "@medusajs/medusa/core-flows";
import { syncInventoryWorkflow } from "../../../workflows/sync-inventory";
import { requireBridgeUrl } from "../../../lib/quickbooks/bridge-url";

/**
 * import-qb-item-by-sku.ts
 *
 * Fetches QB inventory items via the documented working path
 * (`GET /api/products`, same as fetch-missing-qb-ids.ts and
 * sync-prices-core.ts), filters for a single SKU client-side, and creates
 * it in Medusa as a draft single-variant product if missing.
 *
 * DO NOT replace this with custom /api/sync/enqueue raw QBXML — that caused
 * a poison-op stall on 2026-04-20 (memory: project_qb_bridge_poison_op).
 * Only use paths already proven in the codebase.
 *
 * Usage:
 *   QB_SKU=ET2-E11040-24GLD npx medusa exec \
 *     ./src/scripts/qb_sync/core_jobs/import-qb-item-by-sku.ts
 *
 *   # Dry run (no DB writes, just report what would happen):
 *   QB_SKU=ET2-E11040-24GLD DRY_RUN=true npx medusa exec \
 *     ./src/scripts/qb_sync/core_jobs/import-qb-item-by-sku.ts
 *
 *   # Also trigger a MeiliSearch re-index after creation:
 *   QB_SKU=ET2-E11040-24GLD SYNC_MEILI=true npx medusa exec \
 *     ./src/scripts/qb_sync/core_jobs/import-qb-item-by-sku.ts
 */

const BRIDGE_URL = requireBridgeUrl();
const API_KEY =
  process.env.QB_API_KEY;
const POLL_INTERVAL_MS = 30_000;
const MAX_POLL_ATTEMPTS = 20;

interface QbItemInventoryRet {
  ListID?: string;
  Name?: string;
  FullName?: string;
  ManufacturerPartNumber?: string;
  SalesDesc?: string;
  SalesPrice?: string | number;
  PurchaseDesc?: string;
  PurchaseCost?: string | number;
  IsActive?: string | boolean;
  QuantityOnHand?: string | number;
  [key: string]: unknown;
}

function slugify(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function priceToAmount(price: unknown): number {
  // Medusa v2 in this project stores `price.amount` in DOLLARS (major units),
  // not cents. (MAX-12128BKAB has amount=218 for $218.) Do NOT multiply by 100.
  if (price === undefined || price === null || price === "") return 0;
  const n = typeof price === "string" ? parseFloat(price) : Number(price);
  if (isNaN(n)) return 0;
  return Math.round(n * 100) / 100;
}

/**
 * Fetches ALL ACTIVE QB inventory items via the documented working path.
 * Same approach as `check-qb-active-products.ts`. Uses the bridge's
 * buildItemQueryActiveWithDesc which emits QBXML with the correct DTD
 * element order (OwnerID at the end), so QB Desktop accepts it.
 *
 * Do NOT use `/api/products` — its buildItemQuery has `OwnerID` before
 * `IncludeRetElement`, which violates the QBXML DTD and causes HRESULT
 * 0x80040400 ("QuickBooks found an error when parsing the provided XML").
 */
async function fetchAllQbItems(
  log: (msg: string) => void
): Promise<QbItemInventoryRet[]> {
  const endpoint = `${BRIDGE_URL}/api/products/active-with-description`;
  log(`📡 GET ${endpoint} (working documented path)`);
  const initRes = await fetch(endpoint, {
    headers: { "x-api-key": API_KEY, "bypass-tunnel-reminder": "true" },
  });
  if (!initRes.ok) {
    throw new Error(
      `Bridge ${endpoint} → ${initRes.status} ${initRes.statusText}`
    );
  }
  const initJson = (await initRes.json()) as {
    operationId?: string;
  };
  const operationId = initJson.operationId;
  if (!operationId) {
    throw new Error(
      `Bridge did not return operationId. Raw: ${JSON.stringify(initJson)}`
    );
  }
  log(`   operationId = ${operationId}`);

  for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    log(`⏳ Poll ${attempt}/${MAX_POLL_ATTEMPTS} ...`);

    const statusRes = await fetch(
      `${BRIDGE_URL}/api/sync/status/${operationId}`,
      { headers: { "x-api-key": API_KEY, "bypass-tunnel-reminder": "true" } }
    );
    if (!statusRes.ok) {
      log(`   bridge status ${statusRes.status} — retry`);
      continue;
    }
    const statusJson = (await statusRes.json()) as {
      success?: boolean;
      operation?: {
        status?: string;
        error?: string;
        message?: string;
        qbxmlResponse?: string;
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

    if (op.status === "completed") {
      // Structured path (same as sync-prices-core.ts)
      const raw =
        op.result?.QBXML?.QBXMLMsgsRs?.ItemQueryRs?.ItemInventoryRet;
      if (raw) {
        const items = Array.isArray(raw)
          ? (raw as QbItemInventoryRet[])
          : [raw as QbItemInventoryRet];
        log(`✅ Bridge returned ${items.length} inventory items (structured)`);
        return items;
      }
      // Raw XML fallback (same as fetch-missing-qb-ids.ts)
      const rawXml = op.qbxmlResponse;
      if (rawXml) {
        const itemBlocks =
          rawXml.match(/<ItemInventoryRet>[\s\S]*?<\/ItemInventoryRet>/g) ||
          [];
        const items = itemBlocks.map((block) => {
          const get = (tag: string) =>
            block.match(new RegExp(`<${tag}>([^<]+)</${tag}>`))?.[1];
          return {
            ListID: get("ListID"),
            Name: get("Name"),
            FullName: get("FullName"),
            ManufacturerPartNumber: get("ManufacturerPartNumber"),
            SalesDesc: get("SalesDesc"),
            SalesPrice: get("SalesPrice"),
            PurchaseDesc: get("PurchaseDesc"),
            PurchaseCost: get("PurchaseCost"),
            IsActive: get("IsActive"),
            QuantityOnHand: get("QuantityOnHand"),
          };
        });
        log(`✅ Bridge returned ${items.length} inventory items (xml fallback)`);
        return items;
      }
      log(`⚠️  Operation completed but no inventory data found`);
      return [];
    }
    if (op.status === "failed") {
      throw new Error(
        `Bridge operation failed: ${op.error ?? op.message ?? "unknown"}`
      );
    }
  }
  throw new Error(
    `Bridge did not complete within ${MAX_POLL_ATTEMPTS} polls (${
      (POLL_INTERVAL_MS * MAX_POLL_ATTEMPTS) / 60_000
    } min)`
  );
}

export default async function importQbItemBySku({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const query = container.resolve(ContainerRegistrationKeys.QUERY);
  const productModule: IProductModuleService = container.resolve(
    Modules.PRODUCT
  );

  const targetSku = (process.env.QB_SKU || "").trim();
  const isDryRun = process.env.DRY_RUN === "true";
  const shouldSyncMeili = process.env.SYNC_MEILI === "true";

  if (!targetSku) {
    logger.error("❌ QB_SKU env var is required. Example:");
    logger.error("   QB_SKU=ET2-E11040-24GLD npx medusa exec ...");
    return;
  }

  logger.info("═".repeat(65));
  logger.info(`📦 QB Single-Item Import — SKU "${targetSku}"`);
  logger.info(
    `   Mode: ${isDryRun ? "DRY RUN (no writes)" : "LIVE"}   SYNC_MEILI=${shouldSyncMeili}`
  );
  logger.info("═".repeat(65));

  // 1. Already in Medusa as a linked variant (sku matches)?
  const { data: bySku } = await query.graph({
    entity: "variant",
    fields: ["id", "sku", "product.id", "product.title", "metadata"],
    filters: { sku: targetSku },
  });
  if (bySku.length > 0) {
    const v = bySku[0] as {
      id: string;
      sku: string;
      metadata?: Record<string, unknown>;
      product?: { id: string; title: string };
    };
    logger.info(`✅ Already exists in Medusa (SKU match):`);
    logger.info(
      `   variant ${v.id} — product ${v.product?.id} "${v.product?.title}"`
    );
    logger.info(`   metadata.quickbooks_id = ${v.metadata?.quickbooks_id}`);
    logger.info("Nothing to do. Exiting.");
    return;
  }

  // 1b. Orphan product with empty-sku variant (same handle)?
  const handleGuess = slugify(targetSku);
  const { data: byHandle } = await query.graph({
    entity: "product",
    fields: [
      "id",
      "handle",
      "title",
      "status",
      "variants.id",
      "variants.sku",
      "variants.metadata",
    ],
    filters: { handle: handleGuess },
  });
  type OrphanVariant = {
    id: string;
    sku?: string | null;
    metadata?: Record<string, unknown> | null;
  };
  type OrphanProduct = {
    id: string;
    handle: string;
    title?: string;
    status?: string;
    variants?: OrphanVariant[];
  };
  const orphan = byHandle[0] as OrphanProduct | undefined;
  const orphanVariant = orphan?.variants?.find(
    (v) => !v.sku || v.sku.trim() === ""
  );

  logger.info(`🔍 Fetching QB item catalog (active-with-description)...\n`);

  // 2. Bulk fetch from QB (documented working path)
  let qbItems: QbItemInventoryRet[];
  try {
    qbItems = await fetchAllQbItems((m) => logger.info(m));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`❌ Bridge fetch failed: ${msg}`);
    return;
  }

  // 3. Find by Name (QB Name === SKU in this project's convention)
  const target = targetSku.toUpperCase();
  const match = qbItems.find(
    (it) =>
      (it.Name ?? "").trim().toUpperCase() === target ||
      (it.FullName ?? "").trim().toUpperCase() === target
  );
  if (!match) {
    logger.warn(
      `⚠️  SKU "${targetSku}" NOT found among ${qbItems.length} QB items.`
    );
    const prefix = targetSku.slice(0, 6).toUpperCase();
    const near = qbItems
      .filter((it) => (it.Name ?? "").toUpperCase().startsWith(prefix))
      .slice(0, 10);
    if (near.length) {
      logger.info(`   Items starting with "${prefix}":`);
      near.forEach((it) => logger.info(`     • ${it.Name} (${it.ListID})`));
    }
    return;
  }

  const listId = match.ListID ?? null;
  const name = (match.Name ?? match.FullName ?? targetSku).trim();
  const mpn = match.ManufacturerPartNumber ?? null;
  const salesDesc = match.SalesDesc ?? match.PurchaseDesc ?? null;
  const amount = priceToAmount(match.SalesPrice);

  logger.info(`\n✅ Found in QB:`);
  logger.info(`   Name:        ${name}`);
  logger.info(`   ListID:      ${listId}`);
  logger.info(`   MPN:         ${mpn ?? "(none)"}`);
  logger.info(`   SalesPrice:  ${match.SalesPrice ?? "(none)"}  → ${amount} ¢`);
  logger.info(
    `   SalesDesc:   ${salesDesc ? String(salesDesc).slice(0, 120) : "(none)"}`
  );
  logger.info(`   QtyOnHand:   ${match.QuantityOnHand ?? "(n/a)"}`);
  logger.info(`   IsActive:    ${match.IsActive ?? "(n/a)"}`);

  if (isDryRun) {
    if (orphan && orphanVariant) {
      logger.info(
        `\n📋 DRY RUN — would UPDATE existing orphan product ${orphan.id} variant ${orphanVariant.id} (sku, metadata.quickbooks_id, price $${(amount / 100).toFixed(2)}).`
      );
    } else {
      logger.info(
        "\n📋 DRY RUN — would CREATE new product. Re-run without DRY_RUN=true."
      );
    }
    return;
  }

  const handle = slugify(name);
  const importDate = new Date().toISOString().slice(0, 10);
  let productId: string | null = null;

  if (orphan && orphanVariant) {
    // Path A: Attach to existing orphan product with empty-sku variant.
    logger.info(
      `\n🔗 Attaching to existing orphan product ${orphan.id} — updating variant ${orphanVariant.id}`
    );
    const mergedVariantMetadata = {
      ...(orphanVariant.metadata || {}),
      quickbooks_id: listId,
      qb_sku: name,
      ...(mpn ? { mpn } : {}),
    };
    try {
      await updateProductsWorkflow(container).run({
        input: {
          products: [
            {
              id: orphan.id,
              metadata: {
                sales_description:
                  salesDesc ||
                  (orphan as { metadata?: { sales_description?: unknown } })
                    ?.metadata?.sales_description ||
                  null,
                qb_imported: true,
                qb_import_date: importDate,
                qb_import_source: "import-qb-item-by-sku",
              },
              variants: [
                {
                  id: orphanVariant.id,
                  sku: name,
                  metadata: mergedVariantMetadata,
                  ...(amount > 0
                    ? { prices: [{ currency_code: "usd", amount }] }
                    : {}),
                },
              ],
            },
          ],
        },
      });
      productId = orphan.id;

      // updateProductsWorkflow does NOT create a price_set when the variant
      // doesn't already have one — it silently drops the `prices` input.
      // Detect that case and create+link the price_set ourselves.
      if (amount > 0) {
        const { data: priceCheck } = await query.graph({
          entity: "variant",
          fields: ["id", "price_set.id"],
          filters: { id: orphanVariant.id },
        });
        const hasPriceSet = Boolean(
          (priceCheck[0] as { price_set?: { id?: string } } | undefined)
            ?.price_set?.id
        );
        if (!hasPriceSet) {
          logger.info(
            `   ℹ️  Variant had no price_set — creating one with $${(amount / 100).toFixed(2)} USD...`
          );
          const pricing = container.resolve(Modules.PRICING) as unknown as {
            createPriceSets: (input: {
              prices: {
                amount: number;
                currency_code: string;
                rules: object;
              }[];
            }) => Promise<{ id: string }>;
          };
          const remoteLink = container.resolve(
            "remoteLink"
          ) as unknown as {
            create: (links: Record<string, unknown>) => Promise<void>;
          };
          const priceSet = await pricing.createPriceSets({
            prices: [
              { amount, currency_code: "usd", rules: {} },
            ],
          });
          await remoteLink.create({
            [Modules.PRODUCT]: { variant_id: orphanVariant.id },
            [Modules.PRICING]: { price_set_id: priceSet.id },
          });
          logger.info(`   ✅ price_set ${priceSet.id} linked to variant`);
        }
      }

      logger.info(`✅ Linked QB item to existing product ${productId}`);
      logger.info(
        `   variant ${orphanVariant.id} now has sku=${name}, quickbooks_id=${listId}, price=$${(amount / 100).toFixed(2)}`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`❌ updateProductsWorkflow failed: ${msg}`);
      throw err;
    }
  } else {
    // Path B: Create new product + single-variant draft
    const productInput = {
      title: name,
      handle,
      status: "draft" as const,
      metadata: {
        sales_description: salesDesc || null,
        prerender: false,
        qb_imported: true,
        qb_import_date: importDate,
        qb_import_source: "import-qb-item-by-sku",
      },
      variants: [
        {
          title: "Default",
          sku: name,
          manage_inventory: true,
          allow_backorder: false,
          prices: amount > 0 ? [{ currency_code: "usd", amount }] : [],
          metadata: {
            quickbooks_id: listId,
            qb_sku: name,
            ...(mpn ? { mpn } : {}),
          },
        },
      ],
    };

    try {
      const [created] = await productModule.createProducts([
        productInput as unknown as Parameters<
          typeof productModule.createProducts
        >[0][0],
      ]);
      productId = (created as { id: string }).id;
      logger.info(`\n✅ Created Medusa product ${productId} (draft)`);
      logger.info(
        `   → Review in Admin /app/products, set status=published when ready.`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`❌ createProducts failed: ${msg}`);
      throw err;
    }
  }

  // 5. Optional MeiliSearch re-index
  if (shouldSyncMeili) {
    logger.info(`\n🔎 Triggering MeiliSearch re-index...`);
    try {
      const result = await syncInventoryWorkflow(container).run({
        input: {},
      });
      const synced = (result as { result?: { synced?: number } }).result
        ?.synced;
      logger.info(`✅ Meilisearch re-indexed ${synced ?? "?"} inventory items`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`⚠️  Meili sync failed (product was still created): ${msg}`);
      logger.warn(
        `   You can retry from Admin → /app/products-advanced → "Check Product Sync".`
      );
    }
  } else {
    logger.info(
      `\nℹ️  MeiliSearch not updated. Run with SYNC_MEILI=true to re-index, or use Admin → "Check Product Sync".`
    );
  }
}
