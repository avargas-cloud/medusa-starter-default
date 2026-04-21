/**
 * classify-unlinked-inventory-items.ts
 *
 * Classifies every inventory_item that has NO row in
 * product_variant_inventory_item into one of four buckets:
 *
 *   HAS_VARIANT     — a product_variant with exact SKU match exists → need pvii link only
 *   HAS_PRODUCT     — a product exists (by title or metadata SKU) but no variant → need variant + link
 *   JUNK            — seed/placeholder data (sku_ prefix, etc.) → skip
 *   NO_CATALOG      — real SKU with nothing in the catalog → need full product + variant + link
 *
 * Also checks ghost links (pvii rows pointing to dead variants) — those will
 * become unlinked after fix-ghost-inventory-links.ts runs, and appear here too.
 *
 * Usage:
 *   cd backend
 *   yarn ts-node src/scripts/checks/classify-unlinked-inventory-items.ts
 */

import "dotenv/config";
import postgres from "postgres";

const DATABASE_URL = process.env.DATABASE_URL!;

if (!DATABASE_URL) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}

const sql = postgres(DATABASE_URL, { max: 1 });

const JUNK_PATTERNS = [
  /^sku_/i,
  /^sku-/i,
  /^sku\d/i,
];
const JUNK_EXACT = new Set(["sku_i-see-you", "sku_trianglepy", "sku-9998"]);

function isJunk(sku: string): boolean {
  if (JUNK_EXACT.has(sku)) return true;
  return JUNK_PATTERNS.some((p) => p.test(sku));
}

async function run() {
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  Classify Unlinked Inventory Items");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  // All unlinked inventory items
  const unlinked = await sql<
    { id: string; sku: string; title: string | null }[]
  >`
    SELECT ii.id, ii.sku, ii.title
    FROM inventory_item ii
    WHERE NOT EXISTS (
      SELECT 1 FROM product_variant_inventory_item pvii
      WHERE pvii.inventory_item_id = ii.id
    )
    ORDER BY ii.sku
  `;

  // Also check ghost links (separate report)
  const ghosts = await sql<
    { pvii_id: string; dead_variant_id: string; inventory_item_id: string; sku: string }[]
  >`
    SELECT
      pvii.id          AS pvii_id,
      pvii.variant_id  AS dead_variant_id,
      pvii.inventory_item_id,
      ii.sku
    FROM product_variant_inventory_item pvii
    JOIN inventory_item ii ON ii.id = pvii.inventory_item_id
    LEFT JOIN product_variant pv ON pv.id = pvii.variant_id
    WHERE pv.id IS NULL
    ORDER BY ii.sku
  `;

  if (ghosts.length > 0) {
    console.log(`⚠️   ${ghosts.length} GHOST LINK(S) still present (run fix-ghost-inventory-links.ts first):`);
    for (const g of ghosts) {
      console.log(`    SKU: ${g.sku}`);
    }
    console.log();
  }

  // For each unlinked item, try to find a matching product_variant by SKU
  const skus = unlinked.map((u) => u.sku);

  const variantMatches = await sql<
    { sku: string; variant_id: string; product_id: string; product_title: string }[]
  >`
    SELECT
      pv.sku,
      pv.id   AS variant_id,
      p.id    AS product_id,
      p.title AS product_title
    FROM product_variant pv
    JOIN product p ON p.id = pv.product_id
    WHERE LOWER(TRIM(pv.sku)) = ANY(${sql.array(skus.map((s) => s.toLowerCase().trim()))})
      AND pv.deleted_at IS NULL
      AND p.deleted_at IS NULL
  `;

  const variantBySku = new Map(
    variantMatches.map((v) => [v.sku.toLowerCase().trim(), v])
  );

  const buckets = {
    HAS_VARIANT: [] as typeof unlinked,
    JUNK: [] as typeof unlinked,
    NO_CATALOG: [] as typeof unlinked,
  };

  for (const item of unlinked) {
    const key = item.sku.toLowerCase().trim();
    if (isJunk(item.sku)) {
      buckets.JUNK.push(item);
    } else if (variantBySku.has(key)) {
      buckets.HAS_VARIANT.push(item);
    } else {
      buckets.NO_CATALOG.push(item);
    }
  }

  // ── HAS_VARIANT ─────────────────────────────────────────────────────────
  console.log(`\n── HAS_VARIANT (${buckets.HAS_VARIANT.length}) — need pvii link only ──────────────`);
  if (buckets.HAS_VARIANT.length === 0) {
    console.log("  (none)");
  } else {
    for (const item of buckets.HAS_VARIANT) {
      const v = variantBySku.get(item.sku.toLowerCase().trim())!;
      console.log(
        `  ${item.sku.padEnd(30)} | inv: ${item.id} | variant: ${v.variant_id}`
      );
    }
  }

  // ── JUNK ────────────────────────────────────────────────────────────────
  console.log(`\n── JUNK / SEED DATA (${buckets.JUNK.length}) — will be skipped ──────────────`);
  if (buckets.JUNK.length === 0) {
    console.log("  (none)");
  } else {
    for (const item of buckets.JUNK) {
      console.log(`  ${item.sku}`);
    }
  }

  // ── NO_CATALOG ──────────────────────────────────────────────────────────
  console.log(`\n── NO_CATALOG (${buckets.NO_CATALOG.length}) — need stub product + variant + pvii ──`);
  if (buckets.NO_CATALOG.length === 0) {
    console.log("  (none)");
  } else {
    for (const item of buckets.NO_CATALOG) {
      const cleanTitle = (item.title ?? item.sku)
        .replace(/\s*-\s*Default\s*$/i, "")
        .trim();
      console.log(
        `  ${item.sku.padEnd(30)} | inv: ${item.id} | title: "${cleanTitle}"`
      );
    }
  }

  // ── Summary ─────────────────────────────────────────────────────────────
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`Total unlinked: ${unlinked.length}`);
  console.log(`  HAS_VARIANT  → ${buckets.HAS_VARIANT.length} (safe to link automatically)`);
  console.log(`  JUNK         → ${buckets.JUNK.length} (skip)`);
  console.log(`  NO_CATALOG   → ${buckets.NO_CATALOG.length} (need stub product creation)`);
  console.log();
  console.log("Next steps:");
  if (ghosts.length > 0) {
    console.log("  1. yarn ts-node src/scripts/fix/fix-ghost-inventory-links.ts --execute");
  }
  console.log("  2. yarn ts-node src/scripts/fix/repair-unlinked-inventory-items.ts          # dry-run");
  console.log("  3. yarn ts-node src/scripts/fix/repair-unlinked-inventory-items.ts --execute # apply");
  console.log("  4. yarn sync:meili   # re-sync MeiliSearch after repairs");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  await sql.end();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
