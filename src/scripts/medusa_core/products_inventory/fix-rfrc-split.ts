#!/usr/bin/env tsx
/**
 * fix-rfrc-split.ts
 *
 * Fixes incorrect multi-variant product from QB sync:
 *   prod_01KK5CFJ35N6RDC043MSH6PWZ4 (title: ECTSK-RFRC1C5A) currently has 2 variants:
 *     - variant_01KK5CFJ35D24HRKY1ZWJZ1HZG  sku: ECTSK-RFRC1C5A
 *     - variant_01KK5CFJ359DGJG4MCKA0KC79R  sku: ECTSK-RFRC1C8A  (already has prices)
 *
 * Result:
 *   Product A: prod_01KK5CFJ35N6RDC043MSH6PWZ4 → title=ECTSK-RFRC1C5A, single variant, option Title/Default Title
 *   Product B: NEW product               → title=ECTSK-RFRC1C8A, variant MOVED (prices preserved), option Title/Default Title
 *
 * USAGE:
 *   # Dry run (default):
 *   cd backend && npx tsx src/scripts/medusa_core/products_inventory/fix-rfrc-split.ts
 *
 *   # Apply:
 *   cd backend && npx tsx src/scripts/medusa_core/products_inventory/fix-rfrc-split.ts --apply
 */

import { Client } from "pg";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });

const DRY_RUN = !process.argv.includes("--apply");

const PRODUCT_ID = "prod_01KK5CFJ35N6RDC043MSH6PWZ4";
const VARIANT_5A_ID = "variant_01KK5CFJ35D24HRKY1ZWJZ1HZG";
const VARIANT_8A_ID = "variant_01KK5CFJ359DGJG4MCKA0KC79R";
const OPTION_ID = "opt_01KK5CFJ3703WXHERXVHPZJQJM";
const OPTVAL_5A_ID = "optval_01KK5CFJ37AE2A2WZW2KPSG51T";
const OPTVAL_8A_ID = "optval_01KK5CFJ37HRCFY3T5EBTK4V3D";

function makeId(prefix: string): string {
  const ts = Date.now().toString(36).toUpperCase().padStart(10, "0");
  const rand = Math.random().toString(36).substring(2, 14).toUpperCase();
  return `${prefix}_${ts}${rand}`;
}

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  console.log("✅ Connected");
  console.log(
    DRY_RUN ? "🔍 DRY RUN — no changes will be written\n" : "⚡ APPLY MODE\n"
  );

  // ── Read current state ────────────────────────────────────────────────────
  const pRes = await client.query<{
    title: string;
    description: string;
    status: string;
    handle: string;
    thumbnail: string;
    metadata: Record<string, unknown>;
    type_id: string | null;
  }>(
    "SELECT title, description, status, handle, thumbnail, metadata, type_id FROM product WHERE id=$1",
    [PRODUCT_ID]
  );
  if (!pRes.rows.length) {
    console.error("❌ Source product not found");
    process.exit(1);
  }
  const prod = pRes.rows[0];

  console.log(`📦 Source product: "${prod.title}" (${PRODUCT_ID})`);
  console.log(`   Option: "${OPTION_ID}" (Color Options)`);
  console.log(
    `   ├─ optval ${OPTVAL_5A_ID} "5A" → variant ${VARIANT_5A_ID} (ECTSK-RFRC1C5A)`
  );
  console.log(
    `   └─ optval ${OPTVAL_8A_ID} "8A" → variant ${VARIANT_8A_ID} (ECTSK-RFRC1C8A)\n`
  );

  const newProductId = makeId("prod");
  const newOptId = makeId("popt");
  const newOptValId = makeId("poptval");
  const newHandle = "ectsk-rfrc1c8a";

  console.log("📋 PLAN:");
  console.log(`  [A] Keep ${PRODUCT_ID}`);
  console.log(`      - title stays: ECTSK-RFRC1C5A`);
  console.log(`      - option "${OPTION_ID}": rename to "Title"`);
  console.log(`      - optval ${OPTVAL_5A_ID}: rename to "Default Title"`);
  console.log(`      - variant ${VARIANT_5A_ID}: title → "Default Title"`);
  console.log(
    `      - DELETE optval ${OPTVAL_8A_ID} from this product's option`
  );
  console.log(`      - handle → ectsk-rfrc1c5a`);
  console.log(`      - metadata: remove qb_is_variant_parent`);
  console.log();
  console.log(`  [B] Create NEW product ${newProductId}`);
  console.log(`      - title: ECTSK-RFRC1C8A`);
  console.log(`      - handle: ${newHandle}`);
  console.log(`      - option ${newOptId}: "Title"`);
  console.log(`      - optval ${newOptValId}: "Default Title"`);
  console.log(
    `      - MOVE variant ${VARIANT_8A_ID} → product_id = ${newProductId}`
  );
  console.log(`      - variant title → "Default Title"`);
  console.log(
    `      - prices on that variant are PRESERVED (no price changes)`
  );
  console.log(`      - metadata: remove qb_is_variant_parent`);
  console.log();

  if (DRY_RUN) {
    console.log("🔍 DRY RUN complete — run with --apply to execute");
    await client.end();
    return;
  }

  // ── APPLY ─────────────────────────────────────────────────────────────────
  await client.query("BEGIN");
  try {
    // ── A: Fix original product ──────────────────────────────────────────

    // Update metadata: remove qb_is_variant_parent, keep other fields
    const newMetaA = { ...prod.metadata, qb_is_variant_parent: undefined };
    delete newMetaA.qb_is_variant_parent;
    await client.query(
      `UPDATE product SET handle='ectsk-rfrc1c5a', metadata=$1, updated_at=NOW() WHERE id=$2`,
      [JSON.stringify(newMetaA), PRODUCT_ID]
    );

    // Rename option to "Title"
    await client.query(
      `UPDATE product_option SET title='Title', updated_at=NOW() WHERE id=$1`,
      [OPTION_ID]
    );

    // Rename optval 5A → "Default Title"
    await client.query(
      `UPDATE product_option_value SET value='Default Title', updated_at=NOW() WHERE id=$1`,
      [OPTVAL_5A_ID]
    );

    // Ensure variant 5A links to optval_5A (should already be correct, but be safe)
    await client.query(
      `DELETE FROM product_variant_option WHERE variant_id=$1`,
      [VARIANT_5A_ID]
    );
    await client.query(
      `INSERT INTO product_variant_option (variant_id, option_value_id) VALUES ($1, $2)`,
      [VARIANT_5A_ID, OPTVAL_5A_ID]
    );

    // Rename variant 5A title → "Default Title"
    await client.query(
      `UPDATE product_variant SET title='Default Title', updated_at=NOW() WHERE id=$1`,
      [VARIANT_5A_ID]
    );

    // Delete optval 8A (belongs to original product's option, now orphaned)
    await client.query(
      `DELETE FROM product_variant_option WHERE option_value_id=$1`,
      [OPTVAL_8A_ID]
    );
    await client.query(`DELETE FROM product_option_value WHERE id=$1`, [
      OPTVAL_8A_ID,
    ]);

    console.log(`   ✅ [A] Original product updated: ECTSK-RFRC1C5A`);

    // ── B: Create new product for ECTSK-RFRC1C8A ────────────────────────

    const newMetaB = { ...prod.metadata, qb_is_variant_parent: undefined };
    delete newMetaB.qb_is_variant_parent;

    await client.query(
      `INSERT INTO product (id, title, description, status, handle, thumbnail, metadata, type_id, created_at, updated_at)
             VALUES ($1, 'ECTSK-RFRC1C8A', $2, $3, $4, $5, $6, $7, NOW(), NOW())`,
      [
        newProductId,
        prod.description,
        prod.status,
        newHandle,
        prod.thumbnail,
        JSON.stringify(newMetaB),
        prod.type_id,
      ]
    );

    // Create option "Title"
    await client.query(
      `INSERT INTO product_option (id, title, product_id, created_at, updated_at) VALUES ($1, 'Title', $2, NOW(), NOW())`,
      [newOptId, newProductId]
    );

    // Create option value "Default Title"
    await client.query(
      `INSERT INTO product_option_value (id, value, option_id, created_at, updated_at) VALUES ($1, 'Default Title', $2, NOW(), NOW())`,
      [newOptValId, newOptId]
    );

    // MOVE variant 8A to new product (prices stay linked via variant ID — no data loss)
    await client.query(
      `UPDATE product_variant SET product_id=$1, title='Default Title', updated_at=NOW() WHERE id=$2`,
      [newProductId, VARIANT_8A_ID]
    );

    // Relink variant_option for 8A
    await client.query(
      `DELETE FROM product_variant_option WHERE variant_id=$1`,
      [VARIANT_8A_ID]
    );
    await client.query(
      `INSERT INTO product_variant_option (variant_id, option_value_id) VALUES ($1, $2)`,
      [VARIANT_8A_ID, newOptValId]
    );

    console.log(
      `   ✅ [B] New product created: ECTSK-RFRC1C8A → ${newProductId}`
    );
    console.log(`         Variant ${VARIANT_8A_ID} moved (prices preserved)`);

    await client.query("COMMIT");
    console.log("\n✅ Split complete!");
  } catch (err: unknown) {
    await client.query("ROLLBACK");
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n❌ Error — ROLLED BACK: ${msg}`);
    process.exit(1);
  }

  // ── Verify ────────────────────────────────────────────────────────────────
  console.log("\n📊 POST-FIX VERIFICATION:");
  const check = await client.query(`
        SELECT p.id, p.title, pv.sku, pv.title as var_title, po.title as opt_title, pov.value as opt_val
        FROM product p
        JOIN product_variant pv ON pv.product_id = p.id AND pv.deleted_at IS NULL
        LEFT JOIN product_option po ON po.product_id = p.id AND po.deleted_at IS NULL
        LEFT JOIN product_option_value pov ON pov.option_id = po.id
        LEFT JOIN product_variant_option pvo ON pvo.variant_id = pv.id AND pvo.option_value_id = pov.id
        WHERE pv.sku IN ('ECTSK-RFRC1C5A', 'ECTSK-RFRC1C8A')
        ORDER BY pv.sku
    `);
  for (const row of check.rows) {
    console.log(`  Product "${row.title}" (${row.id})`);
    console.log(`    variant: "${row.var_title}" sku=${row.sku}`);
    console.log(`    option:  "${row.opt_title}" → "${row.opt_val}"`);
  }

  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
