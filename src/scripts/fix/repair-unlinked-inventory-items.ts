/**
 * repair-unlinked-inventory-items.ts
 *
 * Repairs inventory items that exist in inventory_item but have no row in
 * product_variant_inventory_item (no variant link).
 *
 * Strategy per item:
 *
 *   1. JUNK (sku_ / sku- prefixed, etc.) → skip entirely.
 *
 *   2. HAS_VARIANT (product_variant with matching SKU exists) → insert a
 *      pvii row linking the existing inventory_item to the found variant.
 *
 *   3. NO_CATALOG (no variant with matching SKU) → create a minimal draft
 *      product + default option + variant in a SQL transaction, then link to
 *      the existing inventory_item.
 *
 * All changes run in DRY-RUN mode by default. Pass --execute to apply.
 *
 * Usage:
 *   cd backend
 *   yarn ts-node src/scripts/fix/repair-unlinked-inventory-items.ts           # dry-run
 *   yarn ts-node src/scripts/fix/repair-unlinked-inventory-items.ts --execute # apply
 *
 * After running with --execute:
 *   yarn sync:meili   # re-sync MeiliSearch so new products appear in POS
 */

import "dotenv/config";
import postgres from "postgres";
import { ulid } from "ulid";

const DRY_RUN = !process.argv.includes("--execute");
const DATABASE_URL = process.env.DATABASE_URL!;

if (!DATABASE_URL) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}

const sql = postgres(DATABASE_URL, { max: 1 });

const JUNK_PATTERNS = [/^sku_/i, /^sku-/i, /^sku\d/i];
const JUNK_EXACT = new Set(["sku_i-see-you", "sku_trianglepy", "sku-9998"]);

function isJunk(sku: string): boolean {
  if (JUNK_EXACT.has(sku)) return true;
  return JUNK_PATTERNS.some((p) => p.test(sku));
}

function makeHandle(sku: string): string {
  return sku
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function cleanTitle(raw: string | null, sku: string): string {
  if (!raw) return sku;
  return raw.replace(/\s*-\s*Default\s*$/i, "").trim() || sku;
}

// Generates Medusa-style prefixed IDs
function makeId(prefix: string): string {
  return `${prefix}_${ulid().toLowerCase()}`;
}

interface UnlinkedItem {
  id: string;
  sku: string;
  title: string | null;
}

interface VariantMatch {
  sku: string;
  variant_id: string;
  product_id: string;
}

async function run() {
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(
    "  Repair Unlinked Inventory Items" +
      (DRY_RUN ? "  [DRY-RUN]" : "  [EXECUTE]")
  );
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  const unlinked = await sql<UnlinkedItem[]>`
    SELECT ii.id, ii.sku, ii.title
    FROM inventory_item ii
    WHERE NOT EXISTS (
      SELECT 1 FROM product_variant_inventory_item pvii
      WHERE pvii.inventory_item_id = ii.id
    )
    ORDER BY ii.sku
  `;

  if (unlinked.length === 0) {
    console.log("✅  No unlinked inventory items — nothing to do.");
    await sql.end();
    return;
  }

  const skus = unlinked.map((u) => u.sku);
  const variantMatches = await sql<VariantMatch[]>`
    SELECT pv.sku, pv.id AS variant_id, pv.product_id
    FROM product_variant pv
    JOIN product p ON p.id = pv.product_id
    WHERE LOWER(TRIM(pv.sku)) = ANY(${sql.array(skus.map((s) => s.toLowerCase().trim()))})
      AND pv.deleted_at IS NULL
      AND p.deleted_at IS NULL
  `;

  const variantBySku = new Map(
    variantMatches.map((v) => [v.sku.toLowerCase().trim(), v])
  );

  // Pre-check: existing handles so we don't collide
  const existingHandles = await sql<{ handle: string }[]>`
    SELECT handle FROM product WHERE deleted_at IS NULL
  `;
  const handleSet = new Set(existingHandles.map((r) => r.handle));

  function uniqueHandle(base: string): string {
    if (!handleSet.has(base)) { handleSet.add(base); return base; }
    let i = 2;
    while (handleSet.has(`${base}-${i}`)) i++;
    const h = `${base}-${i}`;
    handleSet.add(h);
    return h;
  }

  let linked = 0;
  let created = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const item of unlinked) {
    const key = item.sku.toLowerCase().trim();

    // ── JUNK: skip ─────────────────────────────────────────────────────────
    if (isJunk(item.sku)) {
      console.log(`  SKIP  ${item.sku} (junk seed data)`);
      skipped++;
      continue;
    }

    // ── HAS_VARIANT: link only ──────────────────────────────────────────────
    const match = variantBySku.get(key);
    if (match) {
      const pviiId = makeId("pvitem");
      console.log(`  LINK  ${item.sku.padEnd(30)} → variant ${match.variant_id}`);
      if (!DRY_RUN) {
        try {
          await sql`
            INSERT INTO product_variant_inventory_item
              (id, variant_id, inventory_item_id, required_quantity)
            VALUES
              (${pviiId}, ${match.variant_id}, ${item.id}, 1)
            ON CONFLICT DO NOTHING
          `;
          linked++;
        } catch (err) {
          const msg = `LINK failed for ${item.sku}: ${(err as Error).message}`;
          console.error("  ❌  " + msg);
          errors.push(msg);
        }
      } else {
        linked++;
      }
      continue;
    }

    // ── NO_CATALOG: create stub product + option + variant + link ───────────
    const title = cleanTitle(item.title, item.sku);
    const handle = uniqueHandle(makeHandle(item.sku));

    const prodId = makeId("prod");
    const optId = makeId("opt");
    const optValId = makeId("optval");
    const variantId = makeId("variant");
    const pviiId = makeId("pvitem");

    console.log(`  CREATE ${item.sku.padEnd(28)} → new prod ${prodId}  title: "${title}"`);

    if (!DRY_RUN) {
      try {
        await sql.begin(async (tx) => {
          await tx`
            INSERT INTO product
              (id, title, handle, status, is_giftcard, discountable)
            VALUES
              (${prodId}, ${title}, ${handle}, 'draft', false, true)
          `;
          await tx`
            INSERT INTO product_option
              (id, title, product_id)
            VALUES
              (${optId}, 'Title', ${prodId})
          `;
          await tx`
            INSERT INTO product_option_value
              (id, value, option_id)
            VALUES
              (${optValId}, 'Default Title', ${optId})
          `;
          await tx`
            INSERT INTO product_variant
              (id, title, sku, product_id, manage_inventory)
            VALUES
              (${variantId}, 'Default Title', ${item.sku}, ${prodId}, true)
          `;
          await tx`
            INSERT INTO product_variant_option
              (variant_id, option_value_id)
            VALUES
              (${variantId}, ${optValId})
          `;
          await tx`
            INSERT INTO product_variant_inventory_item
              (id, variant_id, inventory_item_id, required_quantity)
            VALUES
              (${pviiId}, ${variantId}, ${item.id}, 1)
          `;
        });
        created++;
      } catch (err) {
        const msg = `CREATE failed for ${item.sku}: ${(err as Error).message}`;
        console.error("  ❌  " + msg);
        errors.push(msg);
      }
    } else {
      created++;
    }
  }

  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  if (DRY_RUN) {
    console.log("⚠️   DRY-RUN — no changes made.");
    console.log(`    Would link   : ${linked}`);
    console.log(`    Would create : ${created} stub product(s)`);
    console.log(`    Would skip   : ${skipped} junk item(s)`);
    console.log("\n    Pass --execute to apply.");
  } else {
    console.log(`✅  Linked   : ${linked} existing variant(s) → inventory item`);
    console.log(`✅  Created  : ${created} stub product(s) with variant + link`);
    console.log(`    Skipped  : ${skipped} junk item(s)`);
    if (errors.length > 0) {
      console.log(`❌  Errors   : ${errors.length}`);
      errors.forEach((e) => console.log("    " + e));
    }
    console.log("\nNext: run  yarn sync:meili  to push new products to MeiliSearch.");
  }
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  await sql.end();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
