/**
 * assign-ecn-connectors.ts
 *
 * Da de alta los 9 conectores ECN (`ECN_CONNECTORS`, src/lib/shop/shop-categories.ts)
 * en la categoría de tienda `for-multi-color-led-strips`: los vincula vía
 * `product_category_product` y escribe `product.metadata.shop_title` +
 * `primary_category_id`. Resuelve cada producto por `title = sku` (0 o >1
 * resultados → abort, no continúa parcial). Dry-run por default; snapshot de
 * metadata + categorías previas a un rollback JSON antes de escribir.
 *
 * `product.title` NUNCA se toca — el "shop title" vive sólo en metadata.
 *
 * Usage:
 *   cd backend
 *   ./node_modules/.bin/tsx src/scripts/fix/assign-ecn-connectors.ts             # dry-run
 *   ./node_modules/.bin/tsx src/scripts/fix/assign-ecn-connectors.ts --execute   # aplica
 *   ./node_modules/.bin/tsx src/scripts/fix/assign-ecn-connectors.ts --revert <rollback.json>
 */

import "dotenv/config";
import fs from "fs";
import os from "os";
import path from "path";
import postgres from "postgres";

import { ECN_CONNECTORS, ECN_TARGET_CATEGORY_HANDLE } from "../../lib/shop/shop-categories";

const DRY_RUN = !process.argv.includes("--execute");
const REVERT_INDEX = process.argv.indexOf("--revert");
const REVERT_FILE = REVERT_INDEX >= 0 ? process.argv[REVERT_INDEX + 1] : null;

// El rollback vive fuera del repo (`backend/tmp` no está gitignored y un JSON
// con datos de prod no puede arriesgarse a un commit). Estable entre sesiones.
const ROLLBACK_DIR =
  process.env.SHOP_RANKS_ROLLBACK_DIR ??
  path.join(os.tmpdir(), "ecopowertech-shop-rollback");

interface ProductSnapshot {
  sku: string;
  product_id: string;
  metadata: Record<string, unknown> | null;
  category_ids: string[];
}

async function revert(sql: postgres.Sql, file: string): Promise<void> {
  const raw = fs.readFileSync(file, "utf-8");
  const rows: ProductSnapshot[] = JSON.parse(raw);
  console.log(`Reverting ${rows.length} products from ${file}`);
  await sql.begin(async (tx) => {
    for (const row of rows) {
      await tx`
        UPDATE product SET metadata = ${JSON.stringify(row.metadata ?? {})}::jsonb
        WHERE id = ${row.product_id}
      `;
      await tx`
        DELETE FROM product_category_product WHERE product_id = ${row.product_id}
      `;
      for (const categoryId of row.category_ids) {
        await tx`
          INSERT INTO product_category_product (product_id, product_category_id)
          VALUES (${row.product_id}, ${categoryId})
          ON CONFLICT DO NOTHING
        `;
      }
    }
  });
  console.log("Revert complete.");
}

async function run(): Promise<void> {
  const DATABASE_URL = process.env.DATABASE_URL;
  if (!DATABASE_URL) {
    console.error("❌ DATABASE_URL not set");
    process.exit(1);
  }

  const sql = postgres(DATABASE_URL);
  try {
    if (REVERT_FILE) {
      await revert(sql, REVERT_FILE);
      return;
    }

    console.log(
      `\n⚙️  assign-ecn-connectors — ${DRY_RUN ? "DRY RUN (no writes)" : "⚡ EXECUTE MODE"}\n`
    );

    const category = await sql<{ id: string }[]>`
      SELECT id FROM product_category
      WHERE handle = ${ECN_TARGET_CATEGORY_HANDLE} AND deleted_at IS NULL
      LIMIT 1
    `;
    if (category.length === 0) {
      console.error(
        `❌ Target category handle not found: ${ECN_TARGET_CATEGORY_HANDLE}`
      );
      process.exit(1);
    }
    const categoryId = category[0].id;

    // Resolver TODOS los productos y snapshotear ANTES de escribir nada —
    // un solo SKU sin match (0 o >1 filas) aborta el script entero.
    const snapshots: ProductSnapshot[] = [];
    for (const { sku } of ECN_CONNECTORS) {
      const products = await sql<
        { id: string; metadata: Record<string, unknown> | null }[]
      >`
        SELECT id, metadata FROM product
        WHERE title = ${sku} AND deleted_at IS NULL
      `;
      if (products.length !== 1) {
        console.error(
          `❌ Product title="${sku}" resolved to ${products.length} row(s) (expected 1). Aborting, no partial apply.`
        );
        process.exit(1);
      }
      const categories = await sql<{ product_category_id: string }[]>`
        SELECT product_category_id FROM product_category_product
        WHERE product_id = ${products[0].id}
      `;
      snapshots.push({
        sku,
        product_id: products[0].id,
        metadata: products[0].metadata,
        category_ids: categories.map((c) => c.product_category_id),
      });
    }

    if (!fs.existsSync(ROLLBACK_DIR)) fs.mkdirSync(ROLLBACK_DIR, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const rollbackPath = path.join(
      ROLLBACK_DIR,
      `ecn-connectors-rollback-${timestamp}.json`
    );
    fs.writeFileSync(rollbackPath, JSON.stringify(snapshots, null, 2));
    console.log(`📥 Rollback snapshot: ${rollbackPath}\n`);

    console.log("Before:");
    console.table(
      snapshots.map((s) => ({
        sku: s.sku,
        product_id: s.product_id,
        categories: s.category_ids.length,
        already_linked: s.category_ids.includes(categoryId),
      }))
    );

    if (!DRY_RUN) {
      await sql.begin(async (tx) => {
        for (let i = 0; i < ECN_CONNECTORS.length; i++) {
          const { shopTitle } = ECN_CONNECTORS[i];
          const snap = snapshots[i];

          await tx`
            INSERT INTO product_category_product (product_id, product_category_id)
            VALUES (${snap.product_id}, ${categoryId})
            ON CONFLICT DO NOTHING
          `;

          await tx`
            UPDATE product
               SET metadata = COALESCE(metadata, '{}'::jsonb)
                 || jsonb_build_object(
                      'shop_title', ${shopTitle}::text,
                      'primary_category_id', ${categoryId}::text
                    )
             WHERE id = ${snap.product_id}
          `;
        }
      });
    }

    const after = await sql<
      { sku: string; product_id: string; shop_title: string | null; linked: boolean }[]
    >`
      SELECT
        p.id AS product_id,
        p.metadata ->> 'shop_title' AS shop_title,
        EXISTS (
          SELECT 1 FROM product_category_product pcp
          WHERE pcp.product_id = p.id AND pcp.product_category_id = ${categoryId}
        ) AS linked
      FROM product p
      WHERE p.id = ANY(${snapshots.map((s) => s.product_id)})
    `;
    console.log("\nAfter:");
    console.table(after);

    console.log(
      DRY_RUN
        ? "\n🧪 Dry run — no changes applied. Re-run with --execute to apply."
        : "\n✅ Applied."
    );
  } finally {
    await sql.end();
  }
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
