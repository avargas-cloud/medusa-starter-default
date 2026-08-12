/**
 * Gate for the vendor metadata key pair.
 *
 *   vendor_full_name / vendor_list_id   — the only spelling
 *   qb_vendor_full_name / qb_vendor_list_id — dropped 2026-08-12, must not return
 *
 * This checks the DATA, not the code: the keys live in JSONB and in SQL
 * template literals, so a green `yarn type-check` says nothing here.
 *
 * The direction of the assertion flipped with the contract. During the expand
 * it demanded that both spellings exist and agree; now it demands the old ones
 * are gone. Keeping the old check would have gone permanently, silently green
 * the moment the drop ran, which is exactly how a gate stops being one.
 *
 * Run:
 *   env DATABASE_URL="$(grep ^DATABASE_URL= .env | cut -d= -f2-)" \
 *     ./node_modules/.bin/tsx src/scripts/verify/verify-vendor-metadata-key-parity.ts
 *
 * Read-only. Exits 1 on any failure.
 */
import { Client } from "pg";

type Check = { label: string; ok: boolean; detail: string };

const results: Check[] = [];
const record = (label: string, ok: boolean, detail: string) =>
  results.push({ label, ok, detail });

const TABLES = ["product", "product_variant"] as const;
const LEGACY = ["qb_vendor_full_name", "qb_vendor_list_id"] as const;

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is required (pass it explicitly — the shell may leak a wrong one).");
    process.exit(1);
  }

  const db = new Client({ connectionString: url });
  await db.connect();

  try {
    // 1. The old spelling is gone. A key that comes BACK means some writer was
    //    never migrated — the failure mode this gate exists to catch.
    for (const table of TABLES) {
      for (const legacy of LEGACY) {
        const r = await db.query<{ n: string; sample: string | null }>(
          `SELECT count(*)::text AS n, MIN(id) AS sample
             FROM "${table}" WHERE metadata->'${legacy}' IS NOT NULL`
        );
        const n = Number(r.rows[0].n);
        record(
          `${table}: ${legacy} no longer exists`,
          n === 0,
          n === 0 ? "0 rows" : `${n} rows still carry it (e.g. ${r.rows[0].sample}) — a writer was missed`
        );
      }
    }

    // 2. The renamed keys are still populated. Without this, "the old key is
    //    gone" would pass on a table where the drop took the value with it.
    const pn = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM product WHERE NULLIF(TRIM(metadata->>'vendor_full_name'), '') IS NOT NULL`
    );
    const pl = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM product WHERE NULLIF(TRIM(metadata->>'vendor_list_id'), '') IS NOT NULL`
    );
    record(
      "product.vendor_full_name still populated",
      Number(pn.rows[0].n) >= 2200,
      `${pn.rows[0].n} rows (2.208 when the rename shipped)`
    );
    record(
      "product.vendor_list_id still populated",
      Number(pl.rows[0].n) >= 2200,
      `${pl.rows[0].n} rows (2.205 when the rename shipped)`
    );

    // 3. Informational: the variant↔qb_vendor link is a FALLBACK, not the
    //    source. A spike here means something re-linked in bulk.
    const drift = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM product_variant pv
         JOIN product p ON p.id = pv.product_id
         JOIN quickbooks_catalog_qb_vendor_product_product_variant l
           ON l.product_variant_id = pv.id AND l.deleted_at IS NULL
         JOIN qb_vendor v ON v.id = l.qb_vendor_id AND v.deleted_at IS NULL
        WHERE pv.deleted_at IS NULL
          AND NULLIF(TRIM(p.metadata->>'vendor_list_id'), '') IS NOT NULL
          AND v.qb_list_id IS NOT NULL
          AND v.qb_list_id IS DISTINCT FROM NULLIF(TRIM(p.metadata->>'vendor_list_id'), '')`
    );
    console.log(
      `\nℹ  the variant↔qb_vendor link disagrees with the product vendor on ${drift.rows[0].n} variants ` +
        `(105 when the rename shipped). Informational — the link is a fallback, not the source.`
    );
  } finally {
    await db.end();
  }

  console.log("");
  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? "✓" : "✗"} ${r.label} — ${r.detail}`);
    if (!r.ok) failed++;
  }
  console.log(
    `\n${results.length - failed}/${results.length} checks passed` +
      (failed ? ` — ${failed} FAILED` : "")
  );
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
