/**
 * backfill-qb-item-type-from-qb.ts
 *
 * Backfills `product.metadata.qb_item_type = 'Inventory'` for products that
 * currently have a NULL qb_item_type but whose SKU is confirmed to be an
 * Inventory Part in QuickBooks Desktop.
 *
 * Source of truth: the bridge's `GET /api/products/active-with-description`
 * returns ONLY `ItemInventoryRet` (inventory items). A SKU present in that
 * result IS an inventory item in QB; a SKU absent is non-inventory and is left
 * untouched (we never guess Service vs NonInventory, and never downgrade an
 * existing value).
 *
 * Read-only against QB (item query). The only writes are to Medusa Postgres.
 *
 * Usage (from backend/, .env loaded → Railway prod):
 *   # dry-run (default): report what would change, no writes
 *   yarn ts-node src/scripts/fix/backfill-qb-item-type-from-qb.ts
 *   # apply
 *   yarn ts-node src/scripts/fix/backfill-qb-item-type-from-qb.ts --execute
 */

import "dotenv/config";
import postgres from "postgres";

const DRY_RUN = !process.argv.includes("--execute");
const BRIDGE_URL = process.env.QB_BRIDGE_URL || "https://qb.eptbridge.com";
const API_KEY = process.env.QB_API_KEY || "mQb-7k9Pzx4RwN2vL8jT3bY6hF5nC1aD";
const POLL_INTERVAL_MS = 30_000;
const MAX_POLL_ATTEMPTS = 20;

interface QbItemInventoryRet {
  ListID?: string;
  Name?: string;
  FullName?: string;
  [key: string]: unknown;
}

/**
 * Fetches ALL active QB inventory items via the documented working path
 * (same as import-qb-item-by-sku.ts). Returns only ItemInventoryRet records.
 */
async function fetchAllQbInventoryItems(
  log: (msg: string) => void
): Promise<QbItemInventoryRet[]> {
  const endpoint = `${BRIDGE_URL}/api/products/active-with-description`;
  log(`📡 GET ${endpoint}`);
  const initRes = await fetch(endpoint, {
    headers: { "x-api-key": API_KEY, "bypass-tunnel-reminder": "true" },
  });
  if (!initRes.ok) {
    throw new Error(`Bridge ${endpoint} → ${initRes.status} ${initRes.statusText}`);
  }
  const initJson = (await initRes.json()) as { operationId?: string };
  const operationId = initJson.operationId;
  if (!operationId) {
    throw new Error(`Bridge returned no operationId. Raw: ${JSON.stringify(initJson)}`);
  }
  log(`   operationId = ${operationId}`);

  for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    log(`⏳ Poll ${attempt}/${MAX_POLL_ATTEMPTS} ...`);
    const statusRes = await fetch(`${BRIDGE_URL}/api/sync/status/${operationId}`, {
      headers: { "x-api-key": API_KEY, "bypass-tunnel-reminder": "true" },
    });
    if (!statusRes.ok) {
      log(`   bridge status ${statusRes.status} — retry`);
      continue;
    }
    const statusJson = (await statusRes.json()) as {
      operation?: {
        status?: string;
        error?: string;
        message?: string;
        qbxmlResponse?: string;
        result?: {
          QBXML?: {
            QBXMLMsgsRs?: { ItemQueryRs?: { ItemInventoryRet?: unknown } };
          };
        };
      };
    };
    const op = statusJson.operation;
    if (!op) continue;

    if (op.status === "completed") {
      const raw = op.result?.QBXML?.QBXMLMsgsRs?.ItemQueryRs?.ItemInventoryRet;
      if (raw) {
        const items = Array.isArray(raw)
          ? (raw as QbItemInventoryRet[])
          : [raw as QbItemInventoryRet];
        log(`✅ Bridge returned ${items.length} inventory items (structured)`);
        return items;
      }
      const rawXml = op.qbxmlResponse;
      if (rawXml) {
        const blocks =
          rawXml.match(/<ItemInventoryRet>[\s\S]*?<\/ItemInventoryRet>/g) || [];
        const items = blocks.map((block) => ({
          ListID: block.match(/<ListID>([^<]+)<\/ListID>/)?.[1],
          Name: block.match(/<Name>([^<]+)<\/Name>/)?.[1],
          FullName: block.match(/<FullName>([^<]+)<\/FullName>/)?.[1],
        }));
        log(`✅ Bridge returned ${items.length} inventory items (xml fallback)`);
        return items;
      }
      log("⚠️  Operation completed but no inventory data found");
      return [];
    }
    if (op.status === "failed") {
      throw new Error(`Bridge operation failed: ${op.error ?? op.message ?? "unknown"}`);
    }
  }
  throw new Error(
    `Bridge did not complete within ${MAX_POLL_ATTEMPTS} polls (${(POLL_INTERVAL_MS * MAX_POLL_ATTEMPTS) / 60_000} min)`
  );
}

async function main() {
  const DATABASE_URL = process.env.DATABASE_URL;
  if (!DATABASE_URL) {
    console.error("❌ DATABASE_URL not set. Run from backend/ with .env loaded.");
    process.exit(1);
  }
  const sql = postgres(DATABASE_URL, { prepare: false });

  // Candidate products: NULL qb_item_type, with at least one non-deleted
  // variant SKU we can match against the QB inventory catalog.
  const candidates = await sql.unsafe<
    { product_id: string; title: string | null; skus: string[] }[]
  >(`
    SELECT p.id AS product_id,
           p.title AS title,
           array_agg(DISTINCT pv.sku) FILTER (WHERE pv.sku IS NOT NULL AND pv.sku <> '') AS skus
      FROM product p
      JOIN product_variant pv ON pv.product_id = p.id AND pv.deleted_at IS NULL
     WHERE p.deleted_at IS NULL
       AND (p.metadata->>'qb_item_type') IS NULL
     GROUP BY p.id, p.title
  `);

  const withSkus = candidates.filter((c) => (c.skus?.length ?? 0) > 0);
  console.log(
    `${DRY_RUN ? "[DRY RUN] " : ""}Found ${candidates.length} product(s) with NULL qb_item_type (${withSkus.length} have matchable SKUs).`
  );
  if (withSkus.length === 0) {
    await sql.end();
    return;
  }

  console.log("\n🔍 Fetching QB inventory catalog (this can take a few minutes)...");
  const qbItems = await fetchAllQbInventoryItems((m) => console.log("   " + m));
  const inventoryNames = new Set(
    qbItems
      .flatMap((it) => [it.Name, it.FullName])
      .filter((n): n is string => Boolean(n))
      .map((n) => n.trim().toUpperCase())
  );
  console.log(`   QB inventory catalog: ${inventoryNames.size} distinct names.\n`);

  const toUpdate: { product_id: string; title: string | null; matchedSku: string }[] = [];
  const skipped: { title: string | null; skus: string[] }[] = [];
  for (const c of withSkus) {
    const matched = c.skus.find((s) => inventoryNames.has(s.trim().toUpperCase()));
    if (matched) {
      toUpdate.push({ product_id: c.product_id, title: c.title, matchedSku: matched });
    } else {
      skipped.push({ title: c.title, skus: c.skus });
    }
  }

  console.log(`✅ ${toUpdate.length} product(s) confirmed Inventory in QB → will set qb_item_type='Inventory':`);
  for (const u of toUpdate) {
    console.log(`   • ${u.matchedSku}  ${u.title ?? "(no title)"}  [${u.product_id}]`);
  }
  if (skipped.length > 0) {
    console.log(`\n⏭️  ${skipped.length} NOT in QB inventory catalog → left NULL (likely non-inventory, not guessed):`);
    for (const s of skipped) {
      console.log(`   • ${s.skus.join(", ")}  ${s.title ?? "(no title)"}`);
    }
  }

  if (toUpdate.length === 0) {
    await sql.end();
    return;
  }

  if (DRY_RUN) {
    console.log(`\n[DRY RUN] Would update ${toUpdate.length} product(s). Re-run with --execute to apply.`);
    await sql.end();
    return;
  }

  const ids = toUpdate.map((u) => u.product_id);
  await sql.unsafe(
    `UPDATE product
        SET metadata = COALESCE(metadata, '{}'::jsonb) || '{"qb_item_type": "Inventory"}'::jsonb,
            updated_at = NOW()
      WHERE id = ANY($1::text[])`,
    [ids]
  );
  console.log(`\n✅ Updated ${toUpdate.length} product(s) → qb_item_type='Inventory'.`);
  await sql.end();
}

main().catch(async (err) => {
  console.error("❌ Script failed:", err);
  process.exit(1);
});
