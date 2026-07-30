/**
 * Seeds `metadata.computed_total` (and its siblings) on SANDBOX orders that
 * lack them, so every order has a reference and the dry run can compare all
 * 1528 instead of the 462 that carry POS metadata.
 *
 * ── Where the seeded value comes from ───────────────────────────────────────
 * The TOTAL THE DOCUMENT SHOWS, not our own arithmetic. Seeding the derivation
 * and then measuring the derivation against it would be the exam and the answer
 * key written by the same hand.
 *
 *   • Order with ONE invoice covering all its lines → `pos_invoice.total`.
 *     A stored, independent document total, the number the customer received.
 *   • Anything else (no invoice, or partially invoiced, where the invoice
 *     legitimately covers less than the order) → the derivation, because the
 *     only other "document" is the POS screen and that is computed live.
 *
 * Every row records which of the two it got, so a later comparison can weigh
 * them differently instead of treating a real invoice and a fallback as equal
 * evidence.
 *
 * Playwright cross-check: the POS screen matched the derivation exactly on
 * S10008 ($59.91), S10010 ($513.30) and S10255 ($4,981.98), which is the basis
 * for using it as the fallback at all.
 *
 * SANDBOX ONLY. Refuses any host that is not the sandbox Postgres — seeding
 * derived values into production metadata would manufacture a reference that
 * looks authoritative and is not.
 *
 * Dry run:  ./node_modules/.bin/tsx src/scripts/fix/seed-sandbox-computed-total.ts
 * Apply:    APPLY=true ./node_modules/.bin/tsx src/scripts/fix/seed-sandbox-computed-total.ts
 */
import { Pool } from "pg";

const APPLY = process.env.APPLY === "true";
const SB =
  process.env.SANDBOX_DATABASE_URL ??
  "postgresql://postgres:sandbox@localhost:5499/medusa";

/** Same scoping as lib/order-money/order-tax-lines.ts: current version only,
 *  newest adjustment per (item, code), NET prices, line taxable flag. */
const CALC = `
WITH ln AS (
  SELECT oi.order_id,
         SUM(ROUND(li.unit_price * 100) * oi.quantity)                        AS net_c,
         SUM(ROUND(li.unit_price * 100) * oi.quantity)
           FILTER (WHERE COALESCE(li.taxable, true))                          AS tax_net_c,
         SUM(ROUND(COALESCE((
           SELECT SUM(ABS(x.amount)) FROM (
             SELECT DISTINCT ON (a.code) a.amount
               FROM order_line_item_adjustment a
              WHERE a.item_id = li.id AND a.deleted_at IS NULL
              ORDER BY a.code, a.version DESC
           ) x), 0) * 100))                                                   AS adj_c,
         SUM(ROUND(COALESCE((
           SELECT SUM(ABS(x.amount)) FROM (
             SELECT DISTINCT ON (a.code) a.amount
               FROM order_line_item_adjustment a
              WHERE a.item_id = li.id AND a.deleted_at IS NULL
              ORDER BY a.code, a.version DESC
           ) x), 0) * 100))
           FILTER (WHERE COALESCE(li.taxable, true))                          AS tax_adj_c
    FROM "order" o
    JOIN order_item oi      ON oi.order_id = o.id AND oi.deleted_at IS NULL
                           AND oi.version  = o.version
    JOIN order_line_item li ON li.id = oi.item_id
   WHERE o.deleted_at IS NULL
   GROUP BY 1
), sh AS (
  SELECT os.order_id, ROUND(COALESCE(SUM(sm.amount), 0) * 100) AS ship_c
    FROM order_shipping os
    JOIN order_shipping_method sm ON sm.id = os.shipping_method_id
    JOIN "order" o ON o.id = os.order_id
   WHERE os.deleted_at IS NULL AND os.version = o.version
   GROUP BY 1
)
SELECT o.id,
       o.metadata->>'document_number'                                    AS doc,
       -- The document's own total, when one invoice covers the whole order.
       (SELECT i.total FROM pos_invoice i
         WHERE i.order_id = o.id AND i.status IS DISTINCT FROM 'voided'
         LIMIT 1)                                                        AS inv_total_c,
       (SELECT count(*) FROM pos_invoice i
         WHERE i.order_id = o.id AND i.status IS DISTINCT FROM 'voided') AS inv_count,
       (SELECT count(*) FROM pos_invoice_item x JOIN pos_invoice i ON i.id = x.invoice_id
         WHERE i.order_id = o.id AND i.status IS DISTINCT FROM 'voided'
           AND x.deleted_at IS NULL AND COALESCE(x.sku,'') <> '')        AS inv_lines,
       (SELECT count(*) FROM order_item oi2 JOIN order_line_item li2 ON li2.id = oi2.item_id
         WHERE oi2.order_id = o.id AND oi2.deleted_at IS NULL
           AND oi2.version = o.version)                                  AS ord_lines,
       CASE WHEN o.metadata->>'tax_mode' = 'exempt' THEN 0 ELSE 7 END    AS rate,
       ln.net_c, ln.adj_c, COALESCE(sh.ship_c, 0)                        AS ship_c,
       GREATEST(0, ln.tax_net_c - ln.tax_adj_c)                          AS tax_base_c,
       ROUND(GREATEST(0, ln.tax_net_c - ln.tax_adj_c)
             * (CASE WHEN o.metadata->>'tax_mode' = 'exempt' THEN 0 ELSE 7 END) / 100.0) AS tax_c
  FROM "order" o
  JOIN ln ON ln.order_id = o.id
  LEFT JOIN sh ON sh.order_id = o.id
 WHERE o.deleted_at IS NULL
   AND o.metadata->>'computed_total' IS NULL
`;

async function main() {
  const u = new URL(SB);
  if (!["localhost", "127.0.0.1"].includes(u.hostname) || u.port !== "5499") {
    throw new Error(
      `refusing: ${u.hostname}:${u.port} is not the sandbox. Seeding a derived ` +
        `value into production metadata would create a reference that looks ` +
        `authoritative and is not.`
    );
  }
  const pool = new Pool({ connectionString: SB });

  const { rows } = await pool.query<any>(CALC);
  console.log(`\n${APPLY ? "APPLY" : "DRY RUN"} · sandbox · ${rows.length} orders without computed_total\n`);

  const n = (v: any) => Number(v ?? 0);
  const pick = (r: any) => {
    const derived = n(r.net_c) - n(r.adj_c) + n(r.ship_c) + n(r.tax_c);
    const fullyInvoiced =
      n(r.inv_count) === 1 && n(r.inv_lines) === n(r.ord_lines) && n(r.inv_total_c) > 0;
    return fullyInvoiced
      ? { totalC: n(r.inv_total_c), source: "invoice" as const, derived }
      : { totalC: derived, source: "derived" as const, derived };
  };

  const fromInvoice = rows.filter((r) => pick(r).source === "invoice").length;
  console.log(`  from the invoice document: ${fromInvoice}`);
  console.log(`  from the derivation:       ${rows.length - fromInvoice}\n`);

  // Where both exist, show how far apart they are — that gap is real evidence
  // about the derivation, unlike the seeded value itself.
  const gaps = rows
    .map((r) => ({ r, p: pick(r) }))
    .filter((x) => x.p.source === "invoice")
    .map((x) => ({ doc: x.r.doc, d: Math.abs(x.p.totalC - x.p.derived) }));
  const off = gaps.filter((g) => g.d > 1);
  console.log(`  invoice vs derivation: ${gaps.length - off.length} agree, ${off.length} differ`);
  for (const g of off.slice(0, 10))
    console.log(`      ${g.doc}: ${(g.d / 100).toFixed(2)} apart`);
  console.log("");

  if (!APPLY) {
    console.log("\n  re-run with APPLY=true to write\n");
    await pool.end();
    return;
  }

  const client = await pool.connect();
  let written = 0;
  try {
    await client.query("BEGIN");
    for (const r of rows) {
      const chosen = pick(r);
      const subC = n(r.net_c) - n(r.adj_c);
      const totalC = chosen.totalC;
      await client.query(
        `UPDATE "order" SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
          WHERE id = $1`,
        [
          r.id,
          JSON.stringify({
            computed_subtotal: n(r.net_c) / 100,
            computed_discount: n(r.adj_c) / 100,
            computed_tax_amount: n(r.tax_c) / 100,
            computed_tax_rate: n(r.rate),
            computed_total: totalC / 100,
            // Stamped so nobody mistakes a seeded baseline for a POS figure,
            // and so a later comparison can tell a real invoice total from a
            // derived fallback.
            computed_source: `sandbox-baseline-${chosen.source}`,
          }),
        ]
      );
      written++;
    }
    await client.query("COMMIT");
    console.log(`\n  committed · ${written} orders seeded\n`);
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
