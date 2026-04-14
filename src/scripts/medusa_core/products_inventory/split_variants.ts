#!/usr/bin/env tsx
/**
 * split_variants.ts
 *
 * For each source product that has multiple variants (migrated incorrectly from QB):
 *   - V1 stays on the original product → update product title = V1.sku
 *   - V2, V3, ... each get a NEW product created, then the variant row is
 *     MOVED (UPDATE product_id) to avoid any SKU uniqueness conflicts
 *
 * Each resulting product:
 *   - title          = variant.sku
 *   - product_option = "Title"
 *   - option_value   = "Default Title"
 *   - variant.title  = "Default Title"
 *
 * USAGE:
 *   # Dry run:
 *   cd backend && npx -y tsx src/scripts/split_variants.ts
 *
 *   # Apply:
 *   cd backend && npx -y tsx src/scripts/split_variants.ts --apply
 */

import { Client } from "pg";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const DRY_RUN = !process.argv.includes("--apply");

const TARGET_PRODUCT_IDS = [
  "prod_01KK5CFJVFVY3RGQD7B1NN0WM8", // EPS-SPR-SPLBO  (2 variants)
  "prod_01KK5CFJVF0YDP03NENWZC93Z1", // EPS-SPR-S-W-   (3 variants)
];

function makeId(prefix: string): string {
  const ts = Date.now().toString(36).toUpperCase().padStart(10, "0");
  const rand = Math.random().toString(36).substring(2, 14).toUpperCase();
  return `${prefix}_${ts}${rand}`;
}

function slugify(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  console.log("✅ Connected\n");
  console.log(DRY_RUN ? "🔍 DRY RUN\n" : "⚡ APPLY MODE\n");

  for (const productId of TARGET_PRODUCT_IDS) {
    // Read source product (including soft-deleted)
    const pRes = await client.query<{
      id: string;
      title: string;
      description: string;
      status: string;
      handle: string;
      thumbnail: string;
      metadata: any;
      type_id: string | null;
    }>(
      "SELECT id,title,description,status,handle,thumbnail,metadata,type_id FROM product WHERE id=$1",
      [productId]
    );

    if (!pRes.rows.length) {
      console.log(`⚠️  ${productId} not found\n`);
      continue;
    }
    const product = pRes.rows[0];

    // Read all variants (including soft-deleted)
    const vRes = await client.query<{
      id: string;
      title: string;
      sku: string | null;
    }>(
      "SELECT id,title,sku FROM product_variant WHERE product_id=$1 ORDER BY created_at ASC",
      [productId]
    );
    const variants = vRes.rows;

    // Read categories
    const catRes = await client.query<{ product_category_id: string }>(
      "SELECT product_category_id FROM product_category_product WHERE product_id=$1",
      [productId]
    );
    const categoryIds = catRes.rows.map((r) => r.product_category_id);

    // Read current option
    const optRes = await client.query<{ id: string }>(
      "SELECT id FROM product_option WHERE product_id=$1 LIMIT 1",
      [productId]
    );
    const existingOptionId = optRes.rows[0]?.id;

    console.log(`📦 "${product.title}" (${productId})`);
    for (const v of variants)
      console.log(`   • [${v.sku ?? "NO SKU"}] "${v.title}"`);

    const v1 = variants[0];
    const extras = variants.slice(1);

    if (DRY_RUN) {
      console.log(`   → Original title → "${v1.sku ?? v1.title}"`);
      for (const v of extras)
        console.log(`   → New product "${v.sku}" ← moved variant`);
      console.log();
      continue;
    }

    await client.query("BEGIN");
    try {
      // ── Fix original product: update title to V1.sku ──────────────────
      const v1Title = v1.sku ?? v1.title;
      await client.query(
        "UPDATE product SET title=$1, deleted_at=NULL WHERE id=$2",
        [v1Title, productId]
      );
      await client.query(
        "UPDATE product_variant SET title='Default Title', deleted_at=NULL WHERE id=$1",
        [v1.id]
      );

      // Ensure original product has option "Title" / "Default Title"
      let origOptId = existingOptionId;
      if (!origOptId) {
        origOptId = makeId("popt");
        await client.query(
          "INSERT INTO product_option (id,title,product_id,created_at,updated_at) VALUES ($1,'Title',$2,NOW(),NOW())",
          [origOptId, productId]
        );
      } else {
        await client.query(
          "UPDATE product_option SET title='Title' WHERE id=$1",
          [origOptId]
        );
      }
      // Upsert option value "Default Title" for V1
      const origOptValRes = await client.query<{ id: string }>(
        "SELECT id FROM product_option_value WHERE option_id=$1 LIMIT 1",
        [origOptId]
      );
      let origOptValId = origOptValRes.rows[0]?.id;
      if (!origOptValId) {
        origOptValId = makeId("poptval");
        await client.query(
          "INSERT INTO product_option_value (id,value,option_id,created_at,updated_at) VALUES ($1,'Default Title',$2,NOW(),NOW())",
          [origOptValId, origOptId]
        );
      } else {
        await client.query(
          "UPDATE product_option_value SET value='Default Title' WHERE id=$1",
          [origOptValId]
        );
      }
      // Link V1 to option value
      await client.query(
        "DELETE FROM product_variant_option WHERE variant_id=$1",
        [v1.id]
      );
      await client.query(
        "INSERT INTO product_variant_option (variant_id,option_value_id) VALUES ($1,$2)",
        [v1.id, origOptValId]
      );

      // ── For each extra variant: create new product + MOVE variant ─────
      for (const v of extras) {
        const newProductId = makeId("prod");
        const newOptId = makeId("popt");
        const newOptValId = makeId("poptval");
        const newTitle = v.sku ?? v.title;
        const newHandle =
          slugify(newTitle) + "-" + newProductId.slice(-6).toLowerCase();

        // Create new product
        await client.query(
          "INSERT INTO product (id,title,description,status,handle,thumbnail,metadata,type_id,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW())",
          [
            newProductId,
            newTitle,
            product.description,
            product.status,
            newHandle,
            product.thumbnail,
            product.metadata,
            product.type_id,
          ]
        );

        // Create option "Title"
        await client.query(
          "INSERT INTO product_option (id,title,product_id,created_at,updated_at) VALUES ($1,'Title',$2,NOW(),NOW())",
          [newOptId, newProductId]
        );

        // Create option value "Default Title"
        await client.query(
          "INSERT INTO product_option_value (id,value,option_id,created_at,updated_at) VALUES ($1,'Default Title',$2,NOW(),NOW())",
          [newOptValId, newOptId]
        );

        // MOVE variant to new product (no new INSERT = no SKU conflict)
        await client.query(
          "UPDATE product_variant SET product_id=$1, title='Default Title', deleted_at=NULL WHERE id=$2",
          [newProductId, v.id]
        );

        // Relink variant option
        await client.query(
          "DELETE FROM product_variant_option WHERE variant_id=$1",
          [v.id]
        );
        await client.query(
          "INSERT INTO product_variant_option (variant_id,option_value_id) VALUES ($1,$2)",
          [v.id, newOptValId]
        );

        // Copy categories
        for (const catId of categoryIds) {
          await client.query(
            "INSERT INTO product_category_product (product_id,product_category_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
            [newProductId, catId]
          );
        }

        console.log(`   ✅ Created "${newTitle}" → ${newProductId}`);
      }

      console.log(`   ✅ Original → "${v1Title}"`);
      await client.query("COMMIT");
    } catch (err: any) {
      await client.query("ROLLBACK");
      console.error(`   ❌ Error: ${err?.detail ?? err?.message}`);
    }
    console.log();
  }

  console.log(`Mode: ${DRY_RUN ? "DRY RUN" : "APPLIED ✅"}\n`);
  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
