/**
 * DRY RUN — replays the total derivation over every order in ONE set-based
 * query and reports what WOULD change. Writes nothing.
 *
 * Why one query: the first version called the helper per order, which is ~3000
 * sequential round-trips to Railway and takes minutes. Everything here is
 * expressible in SQL, so it runs in seconds and the rule can be iterated on.
 *
 * ── The rule being tested ────────────────────────────────────────────────────
 * QuickBooks receives GROSS line prices plus a `Discount` line as a dollar
 * amount, so QB's arithmetic is `Σ gross − discount`. Reproducing it requires
 * the discount the way the POS computed it, which is rounded PER LINE:
 *
 *   S10255: 149.25×10%=14.93 · 2099.70×10%=209.97 · 515.97×10%=51.60 …
 *           = 299.08, exactly QB's Discount line on Invoice 19473.
 *
 * The NET stored in `unit_price` is rounded PER UNIT instead (0.57×0.9 → 0.51),
 * which on a 150-unit line loses 0.3c × 150 = 45c. That 45c of base is the 3c
 * of tax by which our earlier NET-based figure missed QuickBooks.
 *
 * So: gross aggregate, minus the per-line rounded discount, minus any
 * order-level adjustment. Tax on the taxable slice of that, rounded once.
 *
 * Run (prod, read-only):
 *   cd backend && ./node_modules/.bin/tsx src/scripts/checks/replay-order-totals-dryrun.ts
 * Sandbox:  REPLAY_DB="postgresql://postgres:sandbox@localhost:5499/medusa" ...
 */
import { readFileSync } from "fs";
import { join } from "path";

import { Pool } from "pg";

function resolveDb(): string {
  if (process.env.REPLAY_DB) return process.env.REPLAY_DB;
  const env = readFileSync(join(process.cwd(), ".env"), "utf8");
  const m = env.match(/^DATABASE_URL=(.*)$/m);
  if (!m) throw new Error("no DATABASE_URL in .env");
  return m[1]!.trim();
}

const SQL = `
WITH ln AS (
  SELECT oi.order_id,
         li.id,
         oi.quantity                                                        AS q,
         li.unit_price                                                      AS net_u,
         COALESCE(NULLIF(li.metadata->>'original_unit_price','')::numeric,
                  li.unit_price)                                            AS gross_u,
         -- LINE flag only: it is what the POS screen and the real QuickBooks
         -- documents agree on (S10255 screen 240.88 / QB 240.91; the combined
         -- line-AND-product predicate gives 188.41 and matches neither).
         COALESCE(li.taxable,true)                                          AS taxable,
         CASE WHEN li.metadata->'line_discount'->>'type' = 'percent'
              THEN (li.metadata->'line_discount'->>'value')::numeric
              ELSE NULL END                                                 AS disc_pct,
         COALESCE((
           SELECT SUM(ABS(x.amount)) FROM (
             SELECT DISTINCT ON (a.code) a.amount
               FROM order_line_item_adjustment a
              WHERE a.item_id = li.id AND a.deleted_at IS NULL
              ORDER BY a.code, a.version DESC
           ) x
         ), 0)                                                              AS adj
    FROM "order" o
    JOIN order_item oi        ON oi.order_id = o.id AND oi.deleted_at IS NULL
                             AND oi.version  = o.version
    JOIN order_line_item li   ON li.id = oi.item_id
    LEFT JOIN product_variant pv ON pv.id = li.variant_id
    LEFT JOIN product p          ON p.id  = pv.product_id
   WHERE o.deleted_at IS NULL
),
per_line AS (
  SELECT order_id, taxable,
         -- Round the LINE, not the unit. This query answers "what would the fix
         -- store", so it has to round the way the fix does -- and the way QB's
         -- own Subtotal does, read over the bridge on E1497, E1845, E1903 and
         -- E1976. An earlier pass rounded per unit here and reported an impact
         -- for arithmetic no code performs.
         ROUND(gross_u * q * 100)                                           AS gross_c,
         ROUND(net_u   * q * 100)                                           AS net_c,
         -- The discount as the POS computed it: the rate applied to the LINE
         -- total and rounded once, not per unit.
         CASE WHEN disc_pct IS NOT NULL
              THEN ROUND(ROUND(gross_u * q * 100) * disc_pct / 100.0)
              ELSE ROUND(gross_u * q * 100) - ROUND(net_u * q * 100)
         END                                                                AS line_disc_c,
         ROUND(adj * 100)                                                   AS adj_c
    FROM ln
),
agg AS (
  SELECT order_id,
         SUM(gross_c)                                            AS gross_c,
         SUM(net_c)                                              AS net_c,
         SUM(line_disc_c)                                        AS line_disc_c,
         SUM(adj_c)                                              AS adj_c,
         SUM(gross_c)     FILTER (WHERE taxable)                 AS tax_gross_c,
         SUM(net_c)       FILTER (WHERE taxable)                 AS tax_net_c,
         SUM(line_disc_c) FILTER (WHERE taxable)                 AS tax_line_disc_c,
         SUM(adj_c)       FILTER (WHERE taxable)                 AS tax_adj_c
    FROM per_line GROUP BY order_id
),
ship AS (
  -- order_shipping is versioned: scope it or a 40 dollar delivery on a 20-version
  -- order reports as 200.
  SELECT os.order_id, ROUND(COALESCE(SUM(sm.amount),0) * 100) AS ship_c
    FROM order_shipping os
    JOIN order_shipping_method sm ON sm.id = os.shipping_method_id
    JOIN "order" o ON o.id = os.order_id
   WHERE os.deleted_at IS NULL AND os.version = o.version
   GROUP BY os.order_id
),
ord AS (
  SELECT o.id,
         o.metadata->>'document_number' AS doc,
         CASE WHEN o.metadata->>'tax_mode' = 'exempt' THEN 0 ELSE 7 END AS rate,
         ROUND((SELECT s.totals->>'current_order_total' FROM order_summary s
                 WHERE s.order_id=o.id AND s.deleted_at IS NULL
                 ORDER BY s.version DESC LIMIT 1)::numeric * 100)      AS stored_c,
         -- The reference is the total shown INSIDE the order (the POS detail
         -- screen), which is metadata.computed_total. NOT the invoice: an order
         -- that is partially invoiced legitimately differs from its invoice, so
         -- comparing the two conflates different documents and manufactured
         -- about 40 fake disagreements.
         -- (no backticks in SQL comments inside a template literal.)
         ROUND((o.metadata->>'computed_total')::numeric * 100)         AS ref_c,
         -- the discount the document recorded: the invoice header first, then
         -- the POS metadata.
         COALESCE(
           (SELECT i.discount FROM pos_invoice i
             WHERE i.order_id=o.id AND i.status IS DISTINCT FROM 'voided'
             ORDER BY i.created_at LIMIT 1),
           ROUND((o.metadata->>'computed_discount')::numeric * 100)
         )                                                             AS doc_disc_c,
         ROUND((o.metadata->>'computed_subtotal')::numeric * 100)      AS ref_sub_c,
         ROUND((o.metadata->>'computed_tax_amount')::numeric * 100)    AS ref_tax_c,
         COALESCE(o.metadata->>'tax_mode','?')                         AS tax_mode,
         COALESCE((SELECT pr.deposit_cents FROM order_money_projection pr
                    WHERE pr.order_id=o.id), 0)                        AS deposit_c,
         o.is_draft_order                                              AS is_draft,
         CASE WHEN o.metadata->>'document_number' LIKE 'E%' OR o.is_draft_order
              THEN 'estimate' ELSE 'order' END                          AS kind,
         (CURRENT_DATE - o.created_at::date)                           AS age_days,
         (SELECT count(*) FROM pos_invoice i
           WHERE i.order_id=o.id AND i.status IS DISTINCT FROM 'voided') AS invoices
    FROM "order" o WHERE o.deleted_at IS NULL
)
SELECT o.doc, o.stored_c, o.ref_c, o.ref_sub_c, o.ref_tax_c, o.tax_mode, o.kind,
       o.deposit_c, o.rate, o.is_draft, o.age_days, o.invoices,
       a.gross_c, a.net_c, a.line_disc_c, a.adj_c,
       COALESCE(s.ship_c,0) AS ship_c,
       -- QB-parity: gross minus the per-line rounded discount minus adjustments
       GREATEST(0, a.tax_gross_c - a.tax_line_disc_c - a.tax_adj_c)     AS tax_base_c,
       ROUND(GREATEST(0, a.tax_gross_c - a.tax_line_disc_c - a.tax_adj_c) * o.rate / 100.0) AS tax_c,
       (a.gross_c - a.line_disc_c - a.adj_c + COALESCE(s.ship_c,0)
        + ROUND(GREATEST(0, a.tax_gross_c - a.tax_line_disc_c - a.tax_adj_c) * o.rate / 100.0)) AS gross_new_c,
       -- NET variant: unit_price already carries the per-line discount, so only
       -- the order-level adjustment comes off.
       (a.net_c - a.adj_c + COALESCE(s.ship_c,0)
        + ROUND(GREATEST(0, a.tax_net_c - a.tax_adj_c) * o.rate / 100.0)) AS net_new_c,
       -- HYBRID: total from the NET base (correct on the overlapping-discount
       -- orders) but the TAX base from the taxable GROSS minus the discount the
       -- document actually recorded — which is the arithmetic QuickBooks does,
       -- because it receives gross prices and one Discount line.
       (a.net_c - a.adj_c + COALESCE(s.ship_c,0)
        + ROUND(GREATEST(0, a.tax_gross_c - COALESCE(o.doc_disc_c,0) - a.tax_adj_c) * o.rate / 100.0)) AS hyb_new_c
  FROM ord o JOIN agg a ON a.order_id = o.id
  LEFT JOIN ship s ON s.order_id = o.id
`;

type R = Record<string, string | null>;
const n = (v: string | null) => Number(v ?? 0);

async function main() {
  const url = resolveDb();
  const host = new URL(url).host;
  const local = host.includes("localhost") || host.includes("127.0.0.1");
  const pool = new Pool({
    connectionString: url,
    ssl: local ? undefined : { rejectUnauthorized: false },
  });

  console.log(`\nDRY RUN · read-only · one query · ${host}`);
  const t0 = Date.now();
  const { rows } = await pool.query<R>(SQL);
  console.log(`${rows.length} orders in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

  type Tally = { fixed: number; stillOff: number; broken: number; fine: number; up: number; down: number; breaks: string[]; drops: string[] };
  const mk = (): Tally => ({ fixed: 0, stillOff: 0, broken: 0, fine: 0, up: 0, down: 0, breaks: [], drops: [] });
  const T: Record<string, Tally> = { NET: mk(), HYBRID: mk(), GROSS: mk() };
  // Estimates may move freely (an old quote is dead anyway). ORDERS are the ones
  // that must not end up disagreeing with their document, so they get counted
  // apart instead of being diluted in a single number.
  const ORD = mk();
  const ordOff: string[] = [];
  // The population that actually matters: every ORDER, plus estimates still
  // inside their 30-day validity. A quote older than that is dead — the shop
  // writes a new one because prices move — so its total may change freely.
  const LIVE = mk();
  const liveOff: string[] = [];
  let agree = 0, disagree = 0, noRef = 0;
  const stillOffRows: Array<{ doc: string; stored: number; ref: number; next: number; draft: boolean; age: number; inv: number; stale: boolean; zeroTax: boolean }> = [];

  for (const r of rows) {
    if (r.ref_c == null || r.stored_c == null) { noRef++; continue; }
    const stored = n(r.stored_c), ref = n(r.ref_c);
    const offBefore = Math.abs(stored - ref) > 1;
    offBefore ? disagree++ : agree++;
    for (const [name, col] of [["NET", "net_new_c"], ["HYBRID", "hyb_new_c"], ["GROSS", "gross_new_c"]] as const) {
      const t = T[name]!;
      const next = n(r[col]);
      const offAfter = Math.abs(next - ref) > 1;
      if (offBefore && !offAfter) t.fixed++;
      else if (offBefore && offAfter) {
        t.stillOff++;
        if (name === "NET" && stillOffRows.length < 60)
          stillOffRows.push({
            doc: r.doc ?? "(sin numero)",
            stored: stored / 100,
            ref: ref / 100,
            next: next / 100,
            draft: r.is_draft === "true" || r.is_draft === true as any,
            age: n(r.age_days),
            inv: n(r.invoices),
            stale: Math.abs(n(r.ref_sub_c) - n(r.net_c)) > 1,
            zeroTax: n(r.ref_tax_c) === 0 && r.tax_mode !== "exempt" && n(r.ref_sub_c) > 0,
          });
      }
      else if (!offBefore && offAfter) {
        t.broken++;
        if (t.breaks.length < 12)
          t.breaks.push(
            `    ${r.doc}: $${(stored / 100).toFixed(2)} -> $${(next / 100).toFixed(2)} (doc $${(ref / 100).toFixed(2)}, off ${((next - ref) / 100).toFixed(2)})`
          );
      } else t.fine++;
      const relevant =
        name === "NET" && (r.kind === "order" || n(r.age_days) <= 30);
      if (relevant) {
        if (offBefore && !offAfter) LIVE.fixed++;
        else if (offBefore && offAfter) {
          LIVE.stillOff++;
          if (liveOff.length < 40)
            liveOff.push(
              `    ${String(r.doc ?? "(sin nº)").padEnd(10)} ${r.kind} ${String(n(r.age_days)).padStart(3)}d inv=${r.invoices} ` +
                `stored $${(stored / 100).toFixed(2)} | doc $${(ref / 100).toFixed(2)} | ours $${(next / 100).toFixed(2)}` +
                `  (${((next - ref) / 100).toFixed(2)})`
            );
        } else if (!offBefore && offAfter) {
          LIVE.broken++;
          LIVE.breaks.push(
            `    ${r.doc} (${r.kind}, ${n(r.age_days)}d): $${(stored / 100).toFixed(2)} -> $${(next / 100).toFixed(2)} (doc $${(ref / 100).toFixed(2)})`
          );
        } else LIVE.fine++;
        if (next !== stored) LIVE.up++;
      }
      if (name === "NET" && r.kind === "order") {
        if (offBefore && !offAfter) ORD.fixed++;
        else if (offBefore && offAfter) {
          ORD.stillOff++;
          if (ordOff.length < 40)
            ordOff.push(
              `    ${String(r.doc ?? "(sin nº)").padEnd(10)} inv=${r.invoices} ` +
                `stored $${(stored / 100).toFixed(2)} | doc $${(ref / 100).toFixed(2)} | ours $${(next / 100).toFixed(2)}` +
                `  (ours-doc ${((next - ref) / 100).toFixed(2)})`
            );
        } else if (!offBefore && offAfter) {
          ORD.broken++;
          ORD.breaks.push(
            `    ${r.doc}: $${(stored / 100).toFixed(2)} -> $${(next / 100).toFixed(2)} (doc $${(ref / 100).toFixed(2)})`
          );
        } else ORD.fine++;
        if (next !== stored) ORD.up++;
      }
      if (next > stored) t.up++;
      if (next < stored) {
        t.down++;
        if (n(r.deposit_c) > 0 && t.drops.length < 20)
          t.drops.push(
            `    ${r.doc}: $${(stored / 100).toFixed(2)} -> $${(next / 100).toFixed(2)}  deposit $${(n(r.deposit_c) / 100).toFixed(2)}`
          );
      }
    }
  }

  console.log(`baseline: ${agree} agree with their document, ${disagree} disagree, ${noRef} without a reference\n`);
  for (const name of ["NET", "HYBRID", "GROSS"]) {
    const t = T[name]!;
    console.log(`── ${name} ──`);
    console.log(`  FIXED ${t.fixed}   still off ${t.stillOff}   BREAK ${t.broken}   untouched-fine ${t.fine}`);
    console.log(`  up ${t.up}   down ${t.down}   down with a live deposit ${t.drops.length}`);
    if (t.breaks.length) console.log("  would break:\n" + t.breaks.join("\n"));
    if (t.drops.length) console.log("  drops on a deposit:\n" + t.drops.join("\n"));
    console.log("");
  }

  console.log("── WHAT MATTERS: every order + estimates inside their 30-day validity ──");
  console.log(`  FIXED ${LIVE.fixed}   still off ${LIVE.stillOff}   BREAK ${LIVE.broken}   untouched-fine ${LIVE.fine}`);
  console.log(`  totals that would change: ${LIVE.up}`);
  if (LIVE.breaks.length) console.log("  would break:\n" + LIVE.breaks.join("\n"));
  if (liveOff.length) console.log("  still off:\n" + liveOff.join("\n"));
  console.log("");

  console.log("── ORDERS only (estimates excluded: an old quote may move freely) ──");
  console.log(`  FIXED ${ORD.fixed}   still off ${ORD.stillOff}   BREAK ${ORD.broken}   untouched-fine ${ORD.fine}`);
  console.log(`  orders whose stored total would change: ${ORD.up}`);
  if (ORD.breaks.length) console.log("  would break:\n" + ORD.breaks.join("\n"));
  if (ordOff.length) console.log("  still off (neither value matches its document):\n" + ordOff.join("\n"));
  console.log("");

  if (stillOffRows.length) {
    console.log("── NET: still off (neither the stored value nor ours matches the document) ──");
    const stale = stillOffRows.filter((x) => x.stale);
    const zero = stillOffRows.filter((x) => !x.stale && x.zeroTax);
    const rest = stillOffRows.filter((x) => !x.stale && !x.zeroTax);
    console.log(`  reference is STALE (its subtotal no longer matches the lines): ${stale.length}`);
    console.log(`  reference records ZERO tax on a taxable order: ${zero.length}`);
    console.log(`  UNEXPLAINED: ${rest.length}\n`);
    console.log("  ── the unexplained ones ──");
    for (const x of rest) {
      console.log(
        `  ${x.doc.padEnd(11)} ${x.draft ? "draft" : "order"} ${String(x.age).padStart(3)}d inv=${x.inv}  ` +
          `stored $${x.stored.toFixed(2)} | doc $${x.ref.toFixed(2)} | ours $${x.next.toFixed(2)}  ` +
          `(ours-doc ${(x.next - x.ref).toFixed(2)})`
      );
    }

    console.log("");
  }

  await pool.end();
}

main().catch((e) => {
  console.error(`\naborted: ${e.message}\n`);
  process.exitCode = 1;
});
