/**
 * PLAN B — aligns `order_line_item.taxable` with the tax that was ACTUALLY
 * billed, so the corrected total derivation reproduces history instead of
 * changing it.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * The new derivation computes an order's total from its lines. Where a line's
 * `taxable` flag disagrees with what the document charged, the recomputed total
 * will not match the invoice — and the invoice is the record that went to the
 * customer and to QuickBooks. The flag is the thing that is wrong, not the
 * money, so the flag is what moves.
 *
 * ── The population, measured ────────────────────────────────────────────────
 * Of 1188 orders holding exactly one invoice, 1180 already agree to the cent.
 * Of the 8 that do not:
 *   • 4 are PARTIALLY invoiced (S11179, S10885, S11265, S11144) — their invoice
 *     covers fewer lines or quantities than the order, so a difference is
 *     correct and this script must not touch them.
 *   • 3 carry an invoice with `tax = 0` on taxable lines (S10008, S10010,
 *     S10012, all 2026-04-14). The customer was billed and PAID the untaxed
 *     total; the order total still carries the tax and shows a phantom balance
 *     of $3.92 / $33.58 / $29.19 that was never charged.
 *   • 1 is within ten cents.
 *
 * So this script targets the third group: lines whose flag says taxable on a
 * document that charged no tax.
 *
 * ── What it does NOT do ─────────────────────────────────────────────────────
 * It never touches `pos_invoice`, `pos_invoice_item`, or anything in
 * QuickBooks. The invoice is the accounting record and stays exactly as issued.
 * Only `order_line_item.taxable` moves, and only where the document proves what
 * was charged.
 *
 * Dry run (default):  ./node_modules/.bin/tsx src/scripts/fix/align-line-taxable-to-billed.ts
 * Apply:              APPLY=true CONFIRM=SI ./node_modules/.bin/tsx src/scripts/fix/align-line-taxable-to-billed.ts
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
 * Candidates: an order with exactly ONE non-voided invoice, whose invoice
 * charged zero tax, that is NOT tax-exempt, and whose lines are currently
 * flagged taxable. The single-invoice and line-count conditions together keep
 * partially-invoiced orders out — on those a difference is legitimate.
 */
const FIND = `
WITH inv AS (
  SELECT i.order_id, i.id inv_id, i.invoice_number, i.tax, i.subtotal, i.total,
         (SELECT count(*) FROM pos_invoice_item x
           WHERE x.invoice_id = i.id AND x.deleted_at IS NULL
             AND COALESCE(x.sku,'') <> '') AS inv_lines
    FROM pos_invoice i
   WHERE i.status IS DISTINCT FROM 'voided'
), one AS (
  SELECT order_id FROM inv GROUP BY order_id HAVING count(*) = 1
), ord AS (
  SELECT o.id, o.metadata->>'document_number' AS doc,
         COALESCE(o.metadata->>'tax_mode','florida') AS tax_mode,
         (SELECT count(*) FROM order_item oi JOIN order_line_item li ON li.id = oi.item_id
           WHERE oi.order_id = o.id AND oi.deleted_at IS NULL AND oi.version = o.version) AS ord_lines,
         (SELECT count(*) FROM order_item oi JOIN order_line_item li ON li.id = oi.item_id
           WHERE oi.order_id = o.id AND oi.deleted_at IS NULL AND oi.version = o.version
             AND COALESCE(li.taxable, true)) AS taxable_lines,
         COALESCE((SELECT pr.applied_cents FROM order_money_projection pr
                    WHERE pr.order_id = o.id), 0) AS applied_c
    FROM "order" o WHERE o.deleted_at IS NULL
)
SELECT ord.id, ord.doc, inv.invoice_number, inv.tax, inv.total,
       ord.ord_lines, inv.inv_lines, ord.taxable_lines, ord.applied_c
  FROM ord
  JOIN one ON one.order_id = ord.id
  JOIN inv ON inv.order_id = ord.id
 WHERE ord.tax_mode <> 'exempt'
   AND inv.tax = 0
   AND ord.taxable_lines > 0
 ORDER BY ord.doc
`;

async function main() {
  const url = resolveDb();
  const host = new URL(url).host;
  const local = host.includes("localhost") || host.includes("127.0.0.1");
  const pool = new Pool({
    connectionString: url,
    ssl: local ? undefined : { rejectUnauthorized: false },
  });

  console.log(`\n${APPLY ? "APPLY" : "DRY RUN"} · ${host}\n`);

  const { rows } = await pool.query<any>(FIND);
  if (rows.length === 0) {
    console.log("  nothing to align\n");
    await pool.end();
    return;
  }

  const targets: any[] = [];
  for (const r of rows) {
    // Partial invoicing is the disqualifier: if the invoice does not cover the
    // same number of lines as the order, the totals are SUPPOSED to differ and
    // flipping flags would corrupt a correct record.
    const partial = Number(r.inv_lines) !== Number(r.ord_lines);
    // A zero-total invoice proves nothing: its tax is 0 because there is
    // nothing to tax, not because the lines are exempt. The dry run surfaced
    // two of these (S10578, S10861) that the paid-check waved through, since
    // applied 0 trivially equals total 0.
    const zeroDoc = Number(r.total) <= 0;
    // The customer must actually have paid the untaxed amount. Without that,
    // "no tax was charged" is an assumption rather than a fact.
    const paidUntaxed = Math.abs(Number(r.applied_c) - Number(r.total)) <= 1;

    const verdict = partial
      ? "SKIP · partially invoiced, the difference is correct"
      : zeroDoc
        ? "SKIP · zero-total invoice says nothing about taxability"
      : !paidUntaxed
        ? `SKIP · applied ${(Number(r.applied_c) / 100).toFixed(2)} does not match the invoice total ${(Number(r.total) / 100).toFixed(2)}`
        : "ALIGN · flip its taxable lines to false";

    console.log(
      `  ${String(r.doc).padEnd(9)} inv ${r.invoice_number}  ` +
        `tax $0.00  total $${(Number(r.total) / 100).toFixed(2)}  ` +
        `lines ord=${r.ord_lines}/inv=${r.inv_lines}  taxable=${r.taxable_lines}`
    );
    console.log(`            ${verdict}`);
    if (verdict.startsWith("ALIGN")) targets.push(r);
  }

  console.log(`\n  ${targets.length} order(s) to align, ${rows.length - targets.length} skipped\n`);
  if (targets.length === 0 || !APPLY) {
    if (!APPLY && targets.length > 0)
      console.log("  re-run with APPLY=true CONFIRM=SI to write\n");
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
    await client.query("BEGIN");
    let flipped = 0;
    for (const t of targets) {
      const r = await client.query(
        `UPDATE order_line_item li SET taxable = false
          WHERE li.id IN (
            SELECT oi.item_id FROM order_item oi
             WHERE oi.order_id = $1 AND oi.deleted_at IS NULL
               AND oi.version = (SELECT o.version FROM "order" o WHERE o.id = $1)
          )
            AND COALESCE(li.taxable, true) = true`,
        [t.id]
      );
      flipped += r.rowCount ?? 0;
      console.log(`  ${t.doc}: ${r.rowCount} line(s) set to non-taxable`);
    }
    await client.query("COMMIT");
    console.log(`\n  committed · ${flipped} line(s) across ${targets.length} order(s)\n`);
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
