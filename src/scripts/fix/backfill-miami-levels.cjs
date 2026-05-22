/**
 * backfill-miami-levels.cjs — standalone (no Medusa boot)
 *
 * 1. Creates a Miami inventory_level @ 0 for every inventory_item that is
 *    linked to a live variant but has NO level at any location.
 * 2. Soft-deletes orphan inventory_items (no variant link) — old import junk.
 *
 * Direct pg against .env DATABASE_URL (prod). Transactional. Idempotent.
 *
 *   node src/scripts/fix/backfill-miami-levels.cjs            # dry-run
 *   node src/scripts/fix/backfill-miami-levels.cjs --execute  # apply
 */
const fs = require("fs");
const path = require("path");
const { Client } = require("pg");
const { ulid } = require("ulid");

const USA_LOC = "sloc_01KFS2AV3TAKR141KC2D6JCGTR";
const EXECUTE = process.argv.includes("--execute");

function dbUrl() {
  const env = fs.readFileSync(path.resolve(__dirname, "../../../.env"), "utf8");
  const line = env.split("\n").find((l) => l.startsWith("DATABASE_URL="));
  if (!line) throw new Error("DATABASE_URL not found in .env");
  return line.slice("DATABASE_URL=".length).trim();
}

const NO_LEVEL_LINKED = `
  SELECT ii.id, ii.sku
    FROM inventory_item ii
   WHERE ii.deleted_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM inventory_level il
                      WHERE il.inventory_item_id = ii.id AND il.deleted_at IS NULL)
     AND EXISTS (SELECT 1 FROM product_variant_inventory_item pvii
                  WHERE pvii.inventory_item_id = ii.id AND pvii.deleted_at IS NULL)
   ORDER BY ii.sku`;

const NO_LEVEL_ORPHAN = `
  SELECT ii.id, ii.sku
    FROM inventory_item ii
   WHERE ii.deleted_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM inventory_level il
                      WHERE il.inventory_item_id = ii.id AND il.deleted_at IS NULL)
     AND NOT EXISTS (SELECT 1 FROM product_variant_inventory_item pvii
                      WHERE pvii.inventory_item_id = ii.id AND pvii.deleted_at IS NULL)
   ORDER BY ii.sku`;

(async () => {
  const client = new Client({ connectionString: dbUrl() });
  await client.connect();
  console.log(`[backfill-miami-levels] mode=${EXECUTE ? "EXECUTE" : "DRY-RUN"}`);

  try {
    const linked = (await client.query(NO_LEVEL_LINKED)).rows;
    const orphans = (await client.query(NO_LEVEL_ORPHAN)).rows;
    console.log(
      `  linked items missing a level: ${linked.length}\n  orphan items: ${orphans.length}`
    );

    if (!EXECUTE) {
      linked.forEach((r) => console.log(`  would CREATE Miami level for ${r.sku} (${r.id})`));
      orphans.forEach((r) => console.log(`  would DELETE orphan ${r.sku} (${r.id})`));
      console.log("[backfill-miami-levels] dry-run — re-run with --execute");
      return;
    }

    await client.query("BEGIN");

    const zero = JSON.stringify({ value: "0", precision: 20 });
    let created = 0;
    for (const item of linked) {
      const id = `ilev_${ulid()}`;
      await client.query(
        `INSERT INTO inventory_level
           (id, created_at, updated_at, inventory_item_id, location_id,
            stocked_quantity, reserved_quantity, incoming_quantity,
            raw_stocked_quantity, raw_reserved_quantity, raw_incoming_quantity)
         VALUES ($1, now(), now(), $2, $3, 0, 0, 0, $4, $4, $4)`,
        [id, item.id, USA_LOC, zero]
      );
      created++;
    }

    let deleted = 0;
    if (orphans.length > 0) {
      const res = await client.query(
        `UPDATE inventory_item SET deleted_at = now(), updated_at = now()
          WHERE id = ANY($1::text[]) AND deleted_at IS NULL`,
        [orphans.map((o) => o.id)]
      );
      deleted = res.rowCount;
    }

    await client.query("COMMIT");
    console.log(`[backfill-miami-levels] DONE — levels created: ${created}, orphans deleted: ${deleted}`);
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[backfill-miami-levels] ROLLED BACK:", e.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
})();
