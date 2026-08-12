/**
 * Contract half of the vendor metadata rename: drops the old key names.
 *
 *   qb_vendor_full_name  (removed — lives on as vendor_full_name)
 *   qb_vendor_list_id    (removed — lives on as vendor_list_id)
 *
 * ## Why this is a SCRIPT and not a migration
 *
 * Railway runs migrations in predeploy, so a migration would drop the keys
 * while the PREVIOUS build is still serving — and that build writes both
 * spellings. Any product edited during the 5-8 minute cutover would get its
 * old keys written straight back, leaving a handful of rows the drop already
 * passed over. Run by hand once the new build is ACTIVE, this cannot race:
 * by then nothing in the system writes the old names.
 *
 * The reverse ordering is what makes this safe. The live build reads
 * `vendor_full_name` and never consults the old name, so removing it is
 * invisible to production — unlike the expand half, which had to keep both.
 *
 * ## Safety
 *
 * Dry-run by default. Refuses to touch a row whose new key is missing or
 * disagrees with the old one: that would be destroying the only copy of a
 * value. Reports those rows instead and exits non-zero.
 *
 *   env DATABASE_URL="$(grep ^DATABASE_URL= .env | cut -d= -f2-)" \
 *     ./node_modules/.bin/tsx src/scripts/fix/drop-legacy-vendor-metadata-keys.ts
 *
 *   ... APPLY=true ./node_modules/.bin/tsx src/scripts/fix/drop-legacy-vendor-metadata-keys.ts
 */
import { Client } from "pg";

const LEGACY = [
  ["qb_vendor_full_name", "vendor_full_name"],
  ["qb_vendor_list_id", "vendor_list_id"],
] as const;

const TABLES = ["product", "product_variant"] as const;

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is required (pass it explicitly).");
    process.exit(1);
  }
  const apply = process.env.APPLY === "true";
  console.log(apply ? "MODE: APPLY\n" : "MODE: DRY RUN (APPLY=true to write)\n");

  const db = new Client({ connectionString: url });
  await db.connect();
  let unsafe = 0;
  let wouldDrop = 0;

  try {
    // ── Preflight: never drop a value the new key does not already carry ──
    for (const table of TABLES) {
      for (const [legacy, renamed] of LEGACY) {
        const bad = await db.query<{ id: string; legacy: string | null; renamed: string | null }>(
          `SELECT id, metadata->>'${legacy}' AS legacy, metadata->>'${renamed}' AS renamed
             FROM "${table}"
            WHERE metadata->'${legacy}' IS NOT NULL
              AND jsonb_typeof(metadata->'${legacy}') <> 'null'
              AND metadata->>'${legacy}' IS DISTINCT FROM metadata->>'${renamed}'
            LIMIT 20`
        );
        if (bad.rowCount) {
          unsafe += bad.rowCount;
          console.log(`✗ ${table}.${legacy}: ${bad.rowCount} row(s) whose value is NOT in ${renamed}`);
          for (const r of bad.rows.slice(0, 5)) {
            console.log(`    ${r.id}  ${legacy}=${JSON.stringify(r.legacy)}  ${renamed}=${JSON.stringify(r.renamed)}`);
          }
        }
      }
    }

    if (unsafe > 0) {
      console.log(
        `\nREFUSING: ${unsafe} row(s) would lose their only copy of the vendor.` +
          `\nRe-run the expand migration (RenameVendorMetadataKeys) first.`
      );
      process.exit(1);
    }

    // ── Counts, then the drop ──
    for (const table of TABLES) {
      const n = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM "${table}"
          WHERE metadata->'qb_vendor_full_name' IS NOT NULL
             OR metadata->'qb_vendor_list_id' IS NOT NULL`
      );
      const count = Number(n.rows[0].n);
      wouldDrop += count;
      console.log(`${apply ? "dropping" : "would drop"} legacy keys on ${count} ${table} row(s)`);

      if (apply && count > 0) {
        const res = await db.query(
          `UPDATE "${table}"
              SET metadata = metadata - 'qb_vendor_full_name' - 'qb_vendor_list_id'
            WHERE metadata->'qb_vendor_full_name' IS NOT NULL
               OR metadata->'qb_vendor_list_id' IS NOT NULL`
        );
        console.log(`  updated ${res.rowCount} row(s)`);
      }
    }

    if (apply) {
      const left = await db.query<{ n: string }>(
        `SELECT (
           (SELECT count(*) FROM product WHERE metadata->'qb_vendor_full_name' IS NOT NULL OR metadata->'qb_vendor_list_id' IS NOT NULL)
         + (SELECT count(*) FROM product_variant WHERE metadata->'qb_vendor_full_name' IS NOT NULL OR metadata->'qb_vendor_list_id' IS NOT NULL)
         )::text AS n`
      );
      console.log(`\nrows still carrying a legacy key: ${left.rows[0].n} (must be 0)`);
      if (Number(left.rows[0].n) !== 0) process.exit(1);
    }

    console.log(`\n${apply ? "done" : `dry run complete — ${wouldDrop} row(s) affected`}`);
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
