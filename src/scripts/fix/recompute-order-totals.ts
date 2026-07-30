/**
 * STEP 2 — recomputes every order's total from its own lines, with the fixed
 * derivation, and writes it to BOTH places that hold it.
 *
 * Run AFTER `photo-document-totals.ts` and AFTER the code is deployed.
 *
 * ── The THREE places, and why all of them ───────────────────────────────────
 *   `order.metadata.pos_total`                  what /orders shows (wins first)
 *   `order.metadata.computed_total`             what /estimates shows
 *   `order_summary.totals.current_order_total`  the fallback behind both
 *
 * These disagreeing is the bug this whole session is about, and there are three
 * of them, not two: 27 orders hold a `pos_total` and a `computed_total` that do
 * not match. Repairing a subset would move the contradiction rather than end
 * it, so all three are written together or the row is skipped.
 *
 * ── It refuses rather than guesses ──────────────────────────────────────────
 * `loadOrderMoneyBase` throws on a line with a non-finite price or quantity
 * instead of scoring it as zero, because a skipped line silently turns a $500
 * order into a $0 one — six orders in production already carry that shape, and
 * a zero total poisons the deposit clamp in `order_money_projection`. Those
 * orders are listed and left alone; they are a separate repair.
 *
 * ── Invoices are never touched ──────────────────────────────────────────────
 * `pos_invoice` is the issued accounting record. If a recomputed order total
 * disagrees with its invoice, the invoice is right and the disagreement is
 * information for step 3 — not something to overwrite.
 *
 *   ./node_modules/.bin/tsx src/scripts/fix/recompute-order-totals.ts
 *   ONLY=S11210 ./node_modules/.bin/tsx src/scripts/fix/recompute-order-totals.ts
 *   APPLY=true CONFIRM=SI ./node_modules/.bin/tsx src/scripts/fix/recompute-order-totals.ts
 */
import { readFileSync } from "fs";
import { join } from "path";

import { Pool } from "pg";

import {
  computeQbParityTax,
  loadOrderMoneyBase,
} from "../../lib/order-money/order-tax-lines";

const APPLY = process.env.APPLY === "true";
const CONFIRM = process.env.CONFIRM === "SI";
/** Restrict to one document number — for rehearsing a single order first. */
const ONLY = process.env.ONLY ?? "";
const BATCH = 200;
/**
 * How many orders are derived at once.
 *
 * The derivation runs through `loadOrderMoneyBase` per order — deliberately,
 * so this script cannot drift from the formula production uses. That costs 3
 * round trips each, and issued SEQUENTIALLY against Railway the 1528 orders
 * took 17 minutes and then died on `read ETIMEDOUT`. Fanning them out over a
 * real connection pool turns the wall clock into round-trips/CONCURRENCY
 * without touching the arithmetic. Kept well under Postgres' connection limit,
 * which this shares with the live application.
 */
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 16);

function resolveDb(): string {
  if (process.env.TARGET_DB) return process.env.TARGET_DB;
  const env = readFileSync(join(process.cwd(), ".env"), "utf8");
  const m = env.match(/^DATABASE_URL=(.*)$/m);
  if (!m) throw new Error("no DATABASE_URL in .env");
  return m[1]!.trim();
}

const LIST = `
SELECT o.id,
       o.version,
       o.metadata->>'document_number' AS ref,
       CASE WHEN COALESCE(o.metadata->>'tax_mode','florida') = 'exempt'
            THEN 0 ELSE 7 END         AS rate,
       EXTRACT(DAY FROM now() - o.created_at)::int AS age_days,
       -- What the SCREEN shows today, resolved with the same precedence the POS
       -- uses. /orders reads metadata.pos_total first (getOrderTotal in
       -- store-pos/app/(pos)/orders/utils.ts); /estimates reads
       -- metadata.computed_total (EstimateRow.tsx). Measuring "did the printed
       -- total move" against computed_total alone counts 27 orders as changed
       -- whose screen already showed the new figure.
       ROUND(COALESCE(
         CASE WHEN COALESCE(o.is_draft_order,false)
                OR o.metadata->>'document_number' LIKE 'E%'
              THEN NULLIF(o.metadata->>'computed_total','')::numeric
              ELSE COALESCE(
                     NULLIF(o.metadata->>'pos_total','')::numeric,
                     NULLIF(o.metadata->>'computed_total','')::numeric)
         END, 0) * 100)               AS old_doc_c,
       (SELECT ROUND(COALESCE(
                 NULLIF(s.totals->>'current_order_total','')::numeric, 0) * 100)
          FROM order_summary s
         WHERE s.order_id = o.id AND s.version = o.version
         LIMIT 1)                     AS old_list_c,
       -- An order covered by exactly ONE invoice whose line count matches has
       -- an issued document to answer to. A partial invoice legitimately totals
       -- less, so it is deliberately NOT counted as one.
       (SELECT count(*) FROM pos_invoice i
         WHERE i.order_id = o.id AND i.status IS DISTINCT FROM 'voided') AS inv_n,
       (SELECT i.total FROM pos_invoice i
         WHERE i.order_id = o.id AND i.status IS DISTINCT FROM 'voided'
         LIMIT 1)                                                        AS inv_total,
       (SELECT count(*) FROM pos_invoice i
          JOIN pos_invoice_item x ON x.invoice_id = i.id AND x.deleted_at IS NULL
         WHERE i.order_id = o.id AND i.status IS DISTINCT FROM 'voided'
           AND COALESCE(x.sku,'') <> '')                                 AS inv_lines,
       (SELECT count(*) FROM order_item oi2
         WHERE oi2.order_id = o.id AND oi2.deleted_at IS NULL
           AND oi2.version = o.version)                                  AS ord_lines
  FROM "order" o
 WHERE o.deleted_at IS NULL
   AND ($1 = '' OR o.metadata->>'document_number' = $1)
 ORDER BY o.created_at
`;

type Row = {
  id: string;
  version: number;
  ref: string | null;
  rate: string;
  age_days: number | null;
  old_doc_c: string | null;
  old_list_c: string | null;
  inv_n: string | null;
  inv_total: string | null;
  inv_lines: string | null;
  ord_lines: string | null;
};

const money = (c: number) => `$${(c / 100).toFixed(2)}`;

async function main() {
  const url = resolveDb();
  const host = new URL(url).host;
  const local = host.includes("localhost") || host.includes("127.0.0.1");
  const pool = new Pool({
    connectionString: url,
    ssl: local ? undefined : { rejectUnauthorized: false },
    max: CONCURRENCY,
    // A long fan-out over a remote database is exactly where an idle socket
    // gets dropped by something in the middle and the run dies at minute 17
    // with no partial result.
    keepAlive: true,
    idleTimeoutMillis: 60_000,
    connectionTimeoutMillis: 20_000,
  });

  // The photo is required to WRITE, not to look. A dry run changes nothing, so
  // demanding it there would only stop the operator from seeing the damage
  // before deciding whether to take the photo at all.
  const photo = await pool.query<{ ok: boolean }>(
    `SELECT to_regclass('public.document_total_photo') IS NOT NULL AS ok`
  );
  if (APPLY && !photo.rows[0]?.ok) {
    console.error(
      `\nrefusing: document_total_photo does not exist.\n` +
        `Take the photo BEFORE repairing — once the totals move there is no way\n` +
        `to tell which documents changed and which were always like this.\n`
    );
    process.exitCode = 1;
    await pool.end();
    return;
  }

  console.log(`\n${APPLY ? "APPLY" : "DRY RUN"} · ${host}${ONLY ? ` · ONLY=${ONLY}` : ""}\n`);

  const { rows } = await pool.query<Row>(LIST, [ONLY]);

  const planned: Array<{
    r: Row;
    total: number;
    subtotal: number;
    discount: number;
    tax: number;
  }> = [];
  const refused: string[] = [];
  const contradicts: string[] = [];
  let unchanged = 0;

  // Fan out over the pool. A shared cursor rather than fixed slices, so one
  // slow order does not idle the other workers behind it.
  let cursor = 0;
  let done = 0;
  const started = Date.now();
  const worker = async () => {
    for (;;) {
      const i = cursor++;
      if (i >= rows.length) return;
      const r = rows[i]!;
      let base;
      try {
        base = await loadOrderMoneyBase(pool, r.id);
      } catch (e: any) {
        refused.push(
          `    ${String(r.ref ?? r.id).padEnd(10)} ${e.message.slice(0, 100)}`
        );
        continue;
      } finally {
        done++;
        if (done % 250 === 0) {
          const s = Math.round((Date.now() - started) / 1000);
          console.log(`    … ${done}/${rows.length} derived (${s}s)`);
        }
      }
      const rate = Number(r.rate);
      const tax = computeQbParityTax(base.taxableNetDollars, rate);
      const total = Math.round(
        (base.netDollars + base.shippingDollars + tax) * 100
      );

      // An issued invoice is the document the customer holds and QuickBooks
      // booked. If the lines no longer produce its total, the LINES are what
      // drifted -- S10578 carries a single line priced at 0 against a $206.68
      // invoice, and writing the derivation there would replace a real total
      // with zero, which is also the shape that clamps a legitimate deposit to
      // nothing in order_money_projection. Refuse and name it.
      const fullyInvoiced =
        Number(r.inv_n ?? 0) === 1 &&
        Number(r.inv_lines ?? -1) === Number(r.ord_lines ?? -2) &&
        Number(r.inv_total ?? 0) > 0;
      if (fullyInvoiced && Math.abs(total - Number(r.inv_total)) > 1) {
        contradicts.push(
          `    ${String(r.ref ?? r.id).padEnd(10)} invoice ${money(Number(r.inv_total)).padStart(12)}` +
            ` but the lines derive ${money(total).padStart(12)}`
        );
        continue;
      }

      const oldDoc = Number(r.old_doc_c ?? 0);
      const oldList = Number(r.old_list_c ?? 0);
      if (total === oldDoc && total === oldList) {
        unchanged++;
        continue;
      }
      planned.push({
        r,
        total,
        subtotal: Math.round((base.netDollars + base.adjustmentsDollars) * 100),
        discount: Math.round(base.adjustmentsDollars * 100),
        tax: Math.round(tax * 100),
      });
    }
  };
  console.log(`  deriving ${rows.length} order(s), ${CONCURRENCY} at a time…`);
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  // The fan-out finishes in arbitrary order; the report must not.
  planned.sort((a, b) => String(a.r.ref ?? "").localeCompare(String(b.r.ref ?? "")));
  refused.sort();

  console.log(`  ${rows.length} order(s) examined`);
  console.log(`    already coherent, nothing to write   ${unchanged}`);
  console.log(`    would be rewritten                   ${planned.length}`);
  console.log(`    derivation refused                   ${refused.length}`);
  console.log(`    would contradict an issued invoice   ${contradicts.length}  ← left untouched`);
  if (contradicts.length) {
    console.log(
      `\n── skipped: the lines no longer add up to the invoice that was issued ──\n` +
        `   the invoice is the record; these orders need their LINES repaired\n` +
        contradicts.sort().join("\n")
    );
  }

  if (refused.length) {
    console.log(
      `\n── refused: left exactly as they are, they need their own repair ──\n` +
        refused.join("\n")
    );
  }

  // An order that never carried a `computed_total` has no document total to
  // contradict: writing one fills a blank. Counting those together with orders
  // whose printed total actually MOVES turns ~50 real changes into a headline
  // of 1116 and hides the only figure that matters.
  const changed = planned.filter((p) => p.total !== Number(p.r.old_doc_c ?? 0));
  const filled = changed.filter((p) => Number(p.r.old_doc_c ?? 0) === 0);
  const moved = changed.filter((p) => Number(p.r.old_doc_c ?? 0) !== 0);

  console.log(
    `\n  of those:\n` +
      `    ${filled.length} had NO document total — writing one fills a blank\n` +
      `    ${moved.length} MOVE a total the document already showed  ← the ones that matter\n` +
      `    ${planned.length - changed.length} only realign the list to a document total that stays put`
  );
  // Split by what the operator's rule actually protects: a quote past its
  // 30-day validity is dead and may move; an order or a live quote may not.
  const isEstimate = (p: (typeof moved)[number]) =>
    String(p.r.ref ?? "").startsWith("E");
  const deadQuote = moved.filter((p) => isEstimate(p) && Number(p.r.age_days ?? 0) > 30);
  const protectedDocs = moved.filter(
    (p) => !isEstimate(p) || Number(p.r.age_days ?? 0) <= 30
  );
  console.log(
    `      of the ${moved.length}: ${deadQuote.length} are quotes past 30 days (free to move)\n` +
      `                  ${protectedDocs.length} are orders or live quotes  ← these need a decision`
  );

  const show = (p: (typeof moved)[number]) =>
    `    ${String(p.r.ref ?? p.r.id).padEnd(10)} ${String(p.r.age_days ?? "?").padStart(4)}d ` +
    `doc ${money(Number(p.r.old_doc_c ?? 0)).padStart(12)}` +
    ` → ${money(p.total).padStart(12)}   list ${money(Number(p.r.old_list_c ?? 0)).padStart(12)}`;

  if (protectedDocs.length) {
    console.log(`\n── orders and live quotes whose printed total would move ──`);
    console.log(protectedDocs.map(show).join("\n"));
  }
  if (deadQuote.length) {
    console.log(`\n── quotes past 30 days (listed, not a blocker) ──`);
    console.log(deadQuote.slice(0, 15).map(show).join("\n"));
    if (deadQuote.length > 15) console.log(`    … ${deadQuote.length - 15} more`);
  }
  console.log("");

  if (!APPLY) {
    console.log("  re-run with APPLY=true CONFIRM=SI to write\n");
    await pool.end();
    return;
  }
  if (!CONFIRM) {
    console.log("  refusing: APPLY=true requires CONFIRM=SI\n");
    await pool.end();
    return;
  }

  let written = 0;
  for (let i = 0; i < planned.length; i += BATCH) {
    const slice = planned.slice(i, i + BATCH);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const p of slice) {
        // The list value and the document value move together or not at all.
        await client.query(
          `UPDATE order_summary
              SET totals = COALESCE(totals, '{}'::jsonb)
                         || jsonb_build_object('current_order_total', $2::numeric)
            WHERE order_id = $1 AND version = $3`,
          [p.r.id, p.total / 100, p.r.version]
        );
        await client.query(
          `UPDATE "order"
              SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
            WHERE id = $1`,
          [
            p.r.id,
            JSON.stringify({
              computed_subtotal: p.subtotal / 100,
              computed_discount: p.discount / 100,
              computed_tax_amount: p.tax / 100,
              computed_total: p.total / 100,
            }),
          ]
        );
        // `pos_total` is the THIRD field holding this number, and on the
        // /orders list it is the one that wins: `getOrderTotal` reads
        // metadata.pos_total first, then order.total, then the summary. Leaving
        // it behind would repair the document and the summary while the list
        // kept rendering the stale figure — the same contradiction, relocated.
        //
        // Updated only where it ALREADY exists. Creating it on the 1265 orders
        // without one would change which branch of `getOrderTotal` wins for
        // them, and that is a behaviour change nobody asked for.
        await client.query(
          `UPDATE "order"
              SET metadata = metadata || jsonb_build_object('pos_total', $2::numeric)
            WHERE id = $1 AND metadata->>'pos_total' IS NOT NULL`,
          [p.r.id, p.total / 100]
        );
        written++;
      }
      await client.query("COMMIT");
      console.log(`  batch ${i / BATCH + 1}: ${slice.length} written`);
    } catch (e: any) {
      await client.query("ROLLBACK").catch(() => {});
      console.error(`\n  BATCH ROLLED BACK at offset ${i}: ${e.message}\n`);
      process.exitCode = 1;
      client.release();
      break;
    }
    client.release();
  }

  console.log(`\n  committed · ${written} order(s) recomputed\n`);
  await pool.end();
}

main().catch((e) => {
  console.error(`\naborted: ${e.message}\n`);
  process.exitCode = 1;
});
