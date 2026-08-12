/**
 * Gate for the vendor metadata key rename (expand half).
 *
 *   qb_vendor_full_name → vendor_full_name
 *   qb_vendor_list_id   → vendor_list_id
 *
 * During expand BOTH names must exist and agree on every row. This checks the
 * data, not the code — a green `yarn type-check` says nothing here, because the
 * keys live in JSONB and in SQL template literals.
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

function record(label: string, ok: boolean, detail: string): void {
  results.push({ label, ok, detail });
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is required (pass it explicitly — the shell may leak a wrong one).");
    process.exit(1);
  }

  const db = new Client({ connectionString: url });
  await db.connect();

  try {
    for (const table of ["product", "product_variant"]) {
      for (const [legacy, renamed] of [
        ["qb_vendor_full_name", "vendor_full_name"],
        ["qb_vendor_list_id", "vendor_list_id"],
      ]) {
        // 1. Every row carrying a VALUE under the legacy key must carry the
        //    renamed one. A legacy key holding a JSON null carries nothing to
        //    copy — both readers already resolve it to null — so the migration
        //    skips it on purpose and this must not report it (13 such rows in
        //    the sandbox snapshot: 12 list ids, 1 name). The filter excludes
        //    ONLY JSON nulls; a real string still fails this check.
        const missing = await db.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM "${table}"
            WHERE metadata->'${legacy}' IS NOT NULL
              AND jsonb_typeof(metadata->'${legacy}') <> 'null'
              AND metadata->'${renamed}' IS NULL`
        );
        const nMissing = Number(missing.rows[0].n);
        record(
          `${table}.${renamed} present wherever ${legacy} is`,
          nMissing === 0,
          nMissing === 0 ? "0 rows missing it" : `${nMissing} rows carry only ${legacy}`
        );

        // 2. Where both exist they must agree. A row where they diverge is
        //    worse than a missing key: two readers see two different vendors,
        //    which is the exact failure this rename was done to end.
        const diverge = await db.query<{ n: string; sample: string | null }>(
          `SELECT count(*)::text AS n,
                  MIN(id) AS sample
             FROM "${table}"
            WHERE metadata->'${legacy}' IS NOT NULL
              AND metadata->'${renamed}' IS NOT NULL
              AND metadata->>'${legacy}' IS DISTINCT FROM metadata->>'${renamed}'`
        );
        const nDiverge = Number(diverge.rows[0].n);
        record(
          `${table}: ${renamed} agrees with ${legacy}`,
          nDiverge === 0,
          nDiverge === 0
            ? "no divergence"
            : `${nDiverge} rows diverge (e.g. ${diverge.rows[0].sample})`
        );
      }
    }

    // 3. The reason this exists: the Meili vendor must be the PRODUCT-level
    //    one, not the variant↔qb_vendor link. Report how many variants still
    //    disagree — informational, since a divergent link is data the rename
    //    does not fix, but a spike here means something re-linked in bulk.
    const linkDrift = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM product_variant pv
         JOIN product p ON p.id = pv.product_id
         JOIN quickbooks_catalog_qb_vendor_product_product_variant l
           ON l.product_variant_id = pv.id AND l.deleted_at IS NULL
         JOIN qb_vendor v ON v.id = l.qb_vendor_id AND v.deleted_at IS NULL
        WHERE pv.deleted_at IS NULL
          AND COALESCE(p.metadata->>'vendor_list_id', p.metadata->>'qb_vendor_list_id') IS NOT NULL
          AND v.qb_list_id IS NOT NULL
          AND v.qb_list_id
              IS DISTINCT FROM COALESCE(p.metadata->>'vendor_list_id', p.metadata->>'qb_vendor_list_id')`
    );
    console.log(
      `\nℹ  variant↔qb_vendor link disagrees with the product vendor on ${linkDrift.rows[0].n} variants ` +
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
