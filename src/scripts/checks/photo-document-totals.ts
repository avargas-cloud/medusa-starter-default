/**
 * STEP 1 — photographs the total every document shows RIGHT NOW, before the fix
 * changes anything.
 *
 * One row per document, across all three kinds:
 *
 *   estimate   E2087    what the POS shows for the quote
 *   order      S11210   what the POS shows for the order
 *   invoice    21179    what the issued invoice says
 *
 * This is the "what the customer has today" reference. After the backfill
 * recomputes the totals, anything that moved away from this photo is a document
 * that no longer agrees with the copy already in someone's hands — and that is
 * the list step 3 produces.
 *
 * Nothing here decides which number is RIGHT. The photo records what IS, so the
 * comparison can be about change rather than about opinion.
 *
 * ── Where each number comes from ────────────────────────────────────────────
 *   invoice           `pos_invoice.total` — the issued document, immutable.
 *   estimate / order  `metadata.computed_total`, which is the figure the POS
 *                     renders. When absent (84 orders, mostly old ones that
 *                     predate the field) it falls back to the order summary's
 *                     current total and says so in `total_source`, because a
 *                     photo with an unexplained blank is worse than one that
 *                     admits what it could not see.
 *
 * Read-only except for its own table.
 *
 *   ./node_modules/.bin/tsx src/scripts/checks/photo-document-totals.ts
 *   APPLY=true CONFIRM=SI ./node_modules/.bin/tsx src/scripts/checks/photo-document-totals.ts
 */
import { readFileSync } from "fs";
import { join } from "path";

import { Pool } from "pg";

const APPLY = process.env.APPLY === "true";
const CONFIRM = process.env.CONFIRM === "SI";

function resolveDb(): string {
  if (process.env.TARGET_DB) return process.env.TARGET_DB;
  const env = readFileSync(join(process.cwd(), ".env"), "utf8");
  const m = env.match(/^DATABASE_URL=(.*)$/m);
  if (!m) throw new Error("no DATABASE_URL in .env");
  return m[1]!.trim();
}

/**
 * Created by the script, not by a migration: this is a one-release deployment
 * artifact, and concurrent sessions in this repo have collided on migration
 * timestamps before.
 */
const DDL = `
CREATE TABLE IF NOT EXISTS document_total_photo (
  doc_kind      text        NOT NULL,
  doc_id        text        NOT NULL,
  ref_number    text,
  total_cents   bigint      NOT NULL,
  total_source  text        NOT NULL,
  order_id      text,
  order_version integer,
  doc_date      date,
  captured_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (doc_kind, doc_id)
);
CREATE INDEX IF NOT EXISTS document_total_photo_ref_idx
  ON document_total_photo (ref_number);
`;

/**
 * Estimates and orders. `order_summary.totals` is the fallback and is read from
 * the CURRENT version — a summary row from an older version carries the total
 * from before the last edit.
 */
const ORDERS = `
SELECT o.id                                                      AS doc_id,
       o.metadata->>'document_number'                            AS ref_number,
       CASE WHEN COALESCE(o.is_draft_order, false)
              OR o.metadata->>'document_number' LIKE 'E%'
            THEN 'estimate' ELSE 'order' END                     AS doc_kind,
       o.version                                                 AS order_version,
       o.created_at::date                                        AS doc_date,
       NULLIF(o.metadata->>'pos_total','')::numeric              AS pos_total,
       NULLIF(o.metadata->>'computed_total','')::numeric         AS computed_total,
       (SELECT ROUND(COALESCE(
                 NULLIF(s.totals->>'current_order_total','')::numeric, 0) * 100)
          FROM order_summary s
         WHERE s.order_id = o.id AND s.version = o.version
         LIMIT 1)                                                AS summary_c
  FROM "order" o
 WHERE o.deleted_at IS NULL
`;

const INVOICES = `
SELECT i.id                       AS doc_id,
       i.invoice_number::text     AS ref_number,
       i.total                    AS total_cents,
       i.order_id,
       i.created_at::date         AS doc_date
  FROM pos_invoice i
 WHERE i.status IS DISTINCT FROM 'voided'
   AND i.deleted_at IS NULL
`;

type PhotoRow = {
  doc_kind: string;
  doc_id: string;
  ref_number: string | null;
  total_cents: number;
  total_source: string;
  order_id: string | null;
  order_version: number | null;
  doc_date: string | null;
};

async function main() {
  const url = resolveDb();
  const host = new URL(url).host;
  const local = host.includes("localhost") || host.includes("127.0.0.1");
  const pool = new Pool({
    connectionString: url,
    ssl: local ? undefined : { rejectUnauthorized: false },
  });

  console.log(`\n${APPLY ? "APPLY" : "DRY RUN"} · ${host}\n`);

  const photo: PhotoRow[] = [];
  const tally = new Map<string, number>();
  const bump = (k: string) => tally.set(k, (tally.get(k) ?? 0) + 1);

  const { rows: orders } = await pool.query<any>(ORDERS);
  for (const r of orders) {
    // `> 0` is not defensive padding, it is the screen's rule: getOrderTotal
    // and EstimateRow both fall THROUGH a metadata total of zero to the next
    // source, while accepting a summary of zero as the answer. Requiring `> 0`
    // everywhere (or nowhere) photographs a number no user sees.
    const computed = r.computed_total === null ? null : Number(r.computed_total);
    const hasComputed =
      computed !== null && Number.isFinite(computed) && computed > 0;
    const summary = r.summary_c === null ? null : Number(r.summary_c);

    // Follow the SAME precedence the screen follows, or the photo records a
    // number nobody is looking at. `/orders` resolves its total in
    // store-pos/app/(pos)/orders/utils.ts `getOrderTotal`: metadata.pos_total
    // first, then the summary. `/estimates` reads metadata.computed_total
    // (EstimateRow.tsx). Same field name does NOT mean same screen.
    const posTotal = r.pos_total === null ? null : Number(r.pos_total);
    const hasPos =
      r.doc_kind === "order" && posTotal !== null && Number.isFinite(posTotal) && posTotal > 0;

    let cents: number;
    let source: string;
    if (hasPos) {
      cents = Math.round(posTotal! * 100);
      source = "pos_total";
    } else if (hasComputed) {
      cents = Math.round(computed! * 100);
      source = "computed_total";
    } else if (summary !== null && Number.isFinite(summary)) {
      cents = Math.round(summary);
      source = "order_summary";
    } else {
      bump(`${r.doc_kind}:sin total`);
      continue;
    }

    bump(`${r.doc_kind}:${source}`);
    photo.push({
      doc_kind: r.doc_kind,
      doc_id: r.doc_id,
      ref_number: r.ref_number,
      total_cents: cents,
      total_source: source,
      order_id: r.doc_id,
      order_version: Number(r.order_version),
      doc_date: r.doc_date,
    });
  }

  const { rows: invoices } = await pool.query<any>(INVOICES);
  for (const r of invoices) {
    bump("invoice:pos_invoice");
    photo.push({
      doc_kind: "invoice",
      doc_id: r.doc_id,
      ref_number: r.ref_number,
      total_cents: Math.round(Number(r.total_cents)),
      total_source: "pos_invoice",
      order_id: r.order_id,
      order_version: null,
      doc_date: r.doc_date,
    });
  }

  console.log(`  ${photo.length} document(s) photographed\n`);
  for (const [k, n] of [...tally.entries()].sort()) {
    console.log(`    ${k.padEnd(28)} ${n}`);
  }
  console.log("");

  if (!APPLY) {
    console.log("  re-run with APPLY=true CONFIRM=SI to write the photo\n");
    await pool.end();
    return;
  }
  if (!CONFIRM) {
    console.log("  refusing: APPLY=true requires CONFIRM=SI\n");
    await pool.end();
    return;
  }

  const client = await pool.connect();
  try {
    await client.query(DDL);
    // The whole photo is one transaction and replaces any earlier attempt: a
    // half-written picture merged with a fresh one would compare some documents
    // against yesterday and others against today.
    await client.query("BEGIN");
    await client.query("TRUNCATE document_total_photo");

    // Set-based on purpose. The first version pushed 2752 rows one INSERT at a
    // time and was still going after ten minutes against Railway, holding an
    // ACCESS EXCLUSIVE lock from its TRUNCATE the whole while — long enough
    // that even reading the table blocked. Every value already lives in this
    // database, so nothing needs to travel to Node and back.
    //
    // The precedence below is the SAME one the report above prints, and it
    // mirrors the screens: /orders reads metadata.pos_total first
    // (getOrderTotal, store-pos/app/(pos)/orders/utils.ts), /estimates reads
    // metadata.computed_total (EstimateRow.tsx).
    const ins = await client.query(
      `INSERT INTO document_total_photo
         (doc_kind, doc_id, ref_number, total_cents, total_source,
          order_id, order_version, doc_date)
       SELECT k.doc_kind, o.id, o.metadata->>'document_number',
              ROUND(k.val * 100), k.src, o.id, o.version, o.created_at::date
         FROM "order" o
         CROSS JOIN LATERAL (
           SELECT CASE WHEN COALESCE(o.is_draft_order,false)
                         OR o.metadata->>'document_number' LIKE 'E%'
                       THEN 'estimate' ELSE 'order' END AS doc_kind
         ) kind
         CROSS JOIN LATERAL (
           SELECT kind.doc_kind,
                  COALESCE(pick.val, 0) AS val,
                  COALESCE(pick.src, 'none') AS src
             FROM (
               SELECT val, src FROM (
                 VALUES
                   (CASE WHEN kind.doc_kind = 'order'
                         THEN NULLIF(o.metadata->>'pos_total','')::numeric END, 'pos_total'),
                   (NULLIF(o.metadata->>'computed_total','')::numeric, 'computed_total'),
                   ((SELECT NULLIF(s.totals->>'current_order_total','')::numeric
                       FROM order_summary s
                      WHERE s.order_id = o.id AND s.version = o.version
                      LIMIT 1), 'order_summary')
               ) AS c(val, src)
               WHERE c.val IS NOT NULL AND (c.val > 0 OR c.src = 'order_summary')
               LIMIT 1
             ) pick
         ) k
        WHERE o.deleted_at IS NULL
          AND k.src <> 'none'`
    );

    const insInv = await client.query(
      `INSERT INTO document_total_photo
         (doc_kind, doc_id, ref_number, total_cents, total_source,
          order_id, order_version, doc_date)
       SELECT 'invoice', i.id, i.invoice_number::text, ROUND(i.total),
              'pos_invoice', i.order_id, NULL, i.created_at::date
         FROM pos_invoice i
        WHERE i.status IS DISTINCT FROM 'voided' AND i.deleted_at IS NULL`
    );
    console.log(
      `  inserted ${ins.rowCount} order/estimate row(s) + ${insInv.rowCount} invoice row(s)`
    );

    // The precedence now exists TWICE: once in the JS that printed the report
    // above, once in the SQL that just wrote the table. Two copies of a rule
    // drift — it has happened three times in this codebase — so before the
    // COMMIT the write is checked against the report it claims to match. A
    // photo that disagrees with its own summary is not a reference.
    const { rows: written } = await client.query<{
      doc_kind: string;
      total_source: string;
      c: string;
    }>(
      `SELECT doc_kind, total_source, count(*)::text AS c
         FROM document_total_photo GROUP BY 1, 2`
    );
    const mismatches: string[] = [];
    const seen = new Set<string>();
    for (const w of written) {
      const key = `${w.doc_kind}:${w.total_source}`;
      seen.add(key);
      const expected = tally.get(key) ?? 0;
      if (Number(w.c) !== expected) {
        mismatches.push(`    ${key}: table ${w.c}, report ${expected}`);
      }
    }
    for (const [key, expected] of tally) {
      if (key.endsWith(":sin total")) continue;
      if (!seen.has(key)) mismatches.push(`    ${key}: table 0, report ${expected}`);
    }
    if (mismatches.length) {
      await client.query("ROLLBACK");
      console.error(
        `\n  ROLLED BACK — the SQL wrote a different picture than the report:\n` +
          mismatches.join("\n") +
          `\n`
      );
      process.exitCode = 1;
      client.release();
      await pool.end();
      return;
    }

    await client.query("COMMIT");
    const { rows: n } = await client.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM document_total_photo`
    );
    console.log(
      `  committed · ${n[0]!.c} rows in document_total_photo` +
        ` (matches the report, ${written.length} group(s) checked)\n`
    );
  } catch (e: any) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(`\n  ROLLED BACK: ${e.message}\n`);
    process.exitCode = 1;
  } finally {
    client.release();
  }

  await pool.end();
}

main().catch((e) => {
  console.error(`\naborted: ${e.message}\n`);
  process.exitCode = 1;
});
