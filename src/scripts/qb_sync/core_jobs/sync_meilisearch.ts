/**
 * sync_meilisearch.ts
 *
 * Bulk-syncs all active products (with variants/SKUs) into MeiliSearch.
 *
 * USAGE:
 *   cd backend && npx tsx src/scripts/sync_meilisearch.ts
 */

import { Client } from "pg";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

async function main() {
  // ── DB ────────────────────────────────────────────────────────────────────
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  console.log("✅ Connected to DB");

  const res = await db.query<{
    id: string;
    title: string;
    description: string | null;
    handle: string;
    thumbnail: string | null;
    status: string;
    metadata: any;
    skus: string[];
  }>(`
        SELECT
            p.id,
            p.title,
            p.description,
            p.handle,
            p.thumbnail,
            p.status,
            p.metadata,
            COALESCE(
                ARRAY_AGG(pv.sku ORDER BY pv.created_at) FILTER (WHERE pv.sku IS NOT NULL AND pv.deleted_at IS NULL),
                '{}'
            ) AS skus
        FROM product p
        LEFT JOIN product_variant pv ON pv.product_id = p.id
        WHERE p.deleted_at IS NULL
        GROUP BY p.id
        ORDER BY p.title
    `);
  await db.end();

  const products = res.rows;
  console.log(`📦 Found ${products.length} products\n`);

  // ── MeiliSearch ───────────────────────────────────────────────────────────
  const { MeiliSearch } = await import("meilisearch");
  const client = new MeiliSearch({
    host: process.env.MEILISEARCH_HOST || "http://localhost:7700",
    apiKey: process.env.MEILISEARCH_API_KEY || "",
  });

  const index = client.index("products");

  // Build documents
  const documents = products.map((p) => ({
    id: p.id,
    title: p.title,
    description: p.description,
    handle: p.handle,
    thumbnail: p.thumbnail,
    status: p.status,
    variant_sku: p.skus,
    metadata: p.metadata || {},
    metadata_material: p.metadata?.material || null,
    metadata_category: p.metadata?.category || null,
  }));

  // Push in batches of 500
  const BATCH = 500;
  let synced = 0;
  for (let i = 0; i < documents.length; i += BATCH) {
    const batch = documents.slice(i, i + BATCH);
    await index.addDocuments(batch, { primaryKey: "id" });
    synced += batch.length;
    console.log(`  ✅ Synced ${synced}/${documents.length}...`);
  }

  console.log(
    `\n🎉 Done — ${documents.length} products synced to MeiliSearch\n`
  );
}

main().catch((err) => {
  console.error("❌", err);
  process.exit(1);
});
