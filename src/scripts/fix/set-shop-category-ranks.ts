/**
 * set-shop-category-ranks.ts
 *
 * Aplica `SHOP_CATEGORY_RANKS` (src/lib/shop/shop-categories.ts) a
 * `product_category.rank`, y para `led-neon` además `is_active=true,
 * is_internal=false`. Dry-run por default; snapshot completo a un rollback
 * JSON antes de escribir; todo en UNA transacción (falla ruidosamente si un
 * handle no existe — nunca aplica parcial).
 *
 * Usage:
 *   cd backend
 *   ./node_modules/.bin/tsx src/scripts/fix/set-shop-category-ranks.ts             # dry-run
 *   ./node_modules/.bin/tsx src/scripts/fix/set-shop-category-ranks.ts --execute   # aplica
 *   ./node_modules/.bin/tsx src/scripts/fix/set-shop-category-ranks.ts --revert <rollback.json>
 */

import "dotenv/config";
import fs from "fs";
import os from "os";
import path from "path";
import postgres from "postgres";

import { SHOP_CATEGORY_RANKS } from "../../lib/shop/shop-categories";

const DRY_RUN = !process.argv.includes("--execute");
const REVERT_INDEX = process.argv.indexOf("--revert");
const REVERT_FILE = REVERT_INDEX >= 0 ? process.argv[REVERT_INDEX + 1] : null;

// El rollback vive fuera del repo (`backend/tmp` no está gitignored y un JSON
// con datos de prod no puede arriesgarse a un commit). Estable entre sesiones.
const ROLLBACK_DIR =
  process.env.SHOP_RANKS_ROLLBACK_DIR ??
  path.join(os.tmpdir(), "ecopowertech-shop-rollback");

interface CategorySnapshot {
  handle: string;
  id: string;
  rank: number | null;
  is_active: boolean;
  is_internal: boolean;
}

async function revert(sql: postgres.Sql, file: string): Promise<void> {
  const raw = fs.readFileSync(file, "utf-8");
  const rows: CategorySnapshot[] = JSON.parse(raw);
  console.log(`Reverting ${rows.length} categories from ${file}`);
  await sql.begin(async (tx) => {
    for (const row of rows) {
      await tx`
        UPDATE product_category
           SET rank = ${row.rank}, is_active = ${row.is_active}, is_internal = ${row.is_internal}
         WHERE id = ${row.id} AND deleted_at IS NULL
      `;
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
      `\n⚙️  set-shop-category-ranks — ${DRY_RUN ? "DRY RUN (no writes)" : "⚡ EXECUTE MODE"}\n`
    );

    const handles = SHOP_CATEGORY_RANKS.map((r) => r.handle);
    const existing = await sql<CategorySnapshot[]>`
      SELECT handle, id, rank, is_active, is_internal
      FROM product_category
      WHERE handle = ANY(${handles}) AND deleted_at IS NULL
    `;
    const byHandle = new Map(existing.map((row) => [row.handle, row]));

    const missing = handles.filter((h) => !byHandle.has(h));
    if (missing.length > 0) {
      console.error(
        `❌ Missing category handle(s), aborting (no partial apply): ${missing.join(", ")}`
      );
      process.exit(1);
    }

    if (!fs.existsSync(ROLLBACK_DIR)) fs.mkdirSync(ROLLBACK_DIR, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const rollbackPath = path.join(
      ROLLBACK_DIR,
      `shop-ranks-rollback-${timestamp}.json`
    );
    fs.writeFileSync(rollbackPath, JSON.stringify(existing, null, 2));
    console.log(`📥 Rollback snapshot: ${rollbackPath}\n`);

    console.log("Before:");
    console.table(existing);

    if (!DRY_RUN) {
      await sql.begin(async (tx) => {
        for (const { handle, rank } of SHOP_CATEGORY_RANKS) {
          if (handle === "led-neon") {
            await tx`
              UPDATE product_category
                 SET rank = ${rank}, is_active = true, is_internal = false
               WHERE handle = ${handle} AND deleted_at IS NULL
            `;
          } else {
            await tx`
              UPDATE product_category
                 SET rank = ${rank}
               WHERE handle = ${handle} AND deleted_at IS NULL
            `;
          }
        }
      });
    }

    const after = await sql<CategorySnapshot[]>`
      SELECT handle, id, rank, is_active, is_internal
      FROM product_category
      WHERE handle = ANY(${handles}) AND deleted_at IS NULL
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
