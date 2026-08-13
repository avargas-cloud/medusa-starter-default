/**
 * verify-supply-chain-commission — the Commission figure on the China → Miami
 * arrow of reports/purchases/supply-chain.
 *
 *   env DATABASE_URL="$(grep ^DATABASE_URL= .env|cut -d= -f2-)" \
 *     npx medusa exec ./src/scripts/verify/verify-supply-chain-commission.ts
 *
 * Read-only. Exits 1 if any check fails.
 *
 * WHY IT CALLS THE ROUTE'S OWN FUNCTION
 * It imports `fetchAgentCommission` from the route rather than re-deriving the
 * number with a second copy of the same SQL. A copy agrees with a mutation —
 * both halves move together and the check stays green. What makes this one bite
 * is the other side of the comparison: totals measured by hand against
 * production on 2026-08-13, before any of this code existed.
 *
 * WHAT EACH CHECK DEFENDS
 * 1 — the amounts themselves, on three CLOSED months. August is deliberately
 *     absent: it is still accruing, so hardcoding it would fail on its own the
 *     next time Veetech invoices.
 * 2 — drafts stay out. Not cosmetic: on the day this shipped a single draft
 *     (VB-1095, $596.46) was the difference between August reading above or
 *     below the $2,000/month contract floor. Written against live data rather
 *     than that one bill's number, so it keeps meaning something after VB-1095
 *     is confirmed.
 * 3 — the figure is dated by the bill's DOCUMENT DATE, not by when the goods
 *     landed. This is the decision most likely to be "corrected" by someone who
 *     notices it sits under Received (which IS receipt-dated) and assumes it
 *     should match. It shouldn't: the contract counts by invoice date. The
 *     check proves the two attributions are distinguishable in real data AND
 *     that this code picks the invoice one.
 *
 * A vacuous pass is visible: check 2 and 3 report SKIP with a reason when the
 * data they need doesn't exist, and never a silent PASS.
 */

import { fetchAgentCommission } from "../../api/admin/reports/purchases/supply-chain/route";

type Knex = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
};

/** Totals measured against production on 2026-08-13, by hand, before this code. */
const FIXTURES: Array<{ month: string; from: string; to: string; cents: number; orders: number }> = [
  { month: "2026-05", from: "2026-05-01T00:00:00Z", to: "2026-06-01T00:00:00Z", cents: 270574, orders: 6 },
  { month: "2026-06", from: "2026-06-01T00:00:00Z", to: "2026-07-01T00:00:00Z", cents: 298867, orders: 7 },
  { month: "2026-07", from: "2026-07-01T00:00:00Z", to: "2026-08-01T00:00:00Z", cents: 244233, orders: 5 },
];

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export default async function ({
  container,
}: {
  container: { resolve: (k: string) => unknown };
}): Promise<void> {
  const db = container.resolve("__pg_connection__") as Knex;
  const out = (s: string) => process.stdout.write(s);
  let failed = 0;
  let skipped = 0;

  // Context first — a run against a table with no commission bills would pass
  // every check and mean nothing.
  const pop = await db.raw(
    `SELECT vb.status, count(DISTINCT vb.id) AS bills,
            COALESCE(SUM(vbl.qty * vbl.unit_cost_cents), 0)::bigint AS cents
       FROM vendor_bill vb
       JOIN vendor_bill_line vbl ON vbl.vendor_bill_id = vb.id AND vbl.deleted_at IS NULL
      WHERE vb.deleted_at IS NULL
        AND vbl.qb_account_full_name ILIKE 'Commission for Purchase%'
      GROUP BY vb.status ORDER BY vb.status`
  );
  const popRows = pop.rows as Array<Record<string, unknown>>;
  out("\nPopulation (commission bills by status):\n");
  for (const r of popRows) {
    out(`  ${String(r.status).padEnd(12)} ${String(r.bills).padStart(3)} bill(s)  ${usd(Number(r.cents))}\n`);
  }
  if (popRows.length === 0) out("  (none — every check below is vacuous)\n");
  out("\n");

  // ── 1. amounts on closed months ────────────────────────────────────────────
  for (const f of FIXTURES) {
    const got = await fetchAgentCommission(db, f.from, f.to);
    const ok = got.cents === f.cents && got.orders === f.orders;
    if (ok) {
      out(`  PASS  1. ${f.month} = ${usd(f.cents)} / ${f.orders} order(s)\n`);
    } else {
      failed++;
      out(
        `  FAIL  1. ${f.month} expected ${usd(f.cents)} / ${f.orders} order(s), got ` +
          `${usd(got.cents)} / ${got.orders}\n`
      );
    }
  }

  // ── 2. drafts excluded ─────────────────────────────────────────────────────
  // Every month that holds at least one DRAFT commission bill: the figure must
  // equal the non-draft sum, and must be strictly below the sum that counts the
  // draft (otherwise "excluded" is unfalsifiable — a $0 draft proves nothing).
  const draftMonths = await db.raw(
    `SELECT to_char(date_trunc('month', COALESCE(vb.document_date, vb.created_at)), 'YYYY-MM') AS month,
            date_trunc('month', COALESCE(vb.document_date, vb.created_at)) AS m_start,
            COALESCE(SUM(vbl.qty * vbl.unit_cost_cents) FILTER (
              WHERE vb.status IN ('confirmed','synced')), 0)::bigint AS non_draft_cents,
            COALESCE(SUM(vbl.qty * vbl.unit_cost_cents) FILTER (
              WHERE vb.status = 'draft'), 0)::bigint AS draft_cents
       FROM vendor_bill vb
       JOIN vendor_bill_line vbl ON vbl.vendor_bill_id = vb.id AND vbl.deleted_at IS NULL
      WHERE vb.deleted_at IS NULL
        AND vbl.qb_account_full_name ILIKE 'Commission for Purchase%'
      GROUP BY 1, 2
     HAVING COALESCE(SUM(vbl.qty * vbl.unit_cost_cents) FILTER (WHERE vb.status = 'draft'), 0) > 0
      ORDER BY 2`
  );
  const draftRows = draftMonths.rows as Array<Record<string, unknown>>;
  if (draftRows.length === 0) {
    skipped++;
    out("  SKIP  2. drafts excluded — no month currently holds a draft commission bill\n");
  } else {
    for (const r of draftRows) {
      const start = new Date(String(r.m_start));
      const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
      const got = await fetchAgentCommission(db, start.toISOString(), end.toISOString());
      const expected = Number(r.non_draft_cents);
      const withDraft = expected + Number(r.draft_cents);
      if (got.cents === expected && got.cents < withDraft) {
        out(
          `  PASS  2. ${r.month} = ${usd(expected)} (excludes ${usd(Number(r.draft_cents))} still in draft)\n`
        );
      } else {
        failed++;
        out(
          `  FAIL  2. ${r.month} expected ${usd(expected)} without drafts (${usd(withDraft)} with), ` +
            `got ${usd(got.cents)}\n`
        );
      }
    }
  }

  // ── 3. dated by document date, not by the receipt event ────────────────────
  // Attribute every commission bill to the month its PO was last RECEIVED, and
  // find a month where that total differs from the document-date total. The
  // figure must equal the document-date one and NOT the receipt one.
  const divergent = await db.raw(
    `WITH bill_comm AS (
       SELECT vb.id, vb.purchase_order_id,
              date_trunc('month', COALESCE(vb.document_date, vb.created_at)) AS doc_month,
              SUM(vbl.qty * vbl.unit_cost_cents)::bigint AS cents
         FROM vendor_bill vb
         JOIN vendor_bill_line vbl ON vbl.vendor_bill_id = vb.id AND vbl.deleted_at IS NULL
        WHERE vb.deleted_at IS NULL AND vb.status IN ('confirmed','synced')
          AND vbl.qb_account_full_name ILIKE 'Commission for Purchase%'
        GROUP BY 1, 2, 3
     ),
     recv AS (
       SELECT bc.id,
              date_trunc('month', (
                SELECT MAX(por.received_at) FROM purchase_order_receipt por
                 WHERE por.purchase_order_id = bc.purchase_order_id
                   AND por.status = 'applied' AND por.voided_at IS NULL AND por.deleted_at IS NULL
              )) AS recv_month
         FROM bill_comm bc
     )
     SELECT to_char(bc.doc_month, 'YYYY-MM') AS month, bc.doc_month AS m_start,
            SUM(bc.cents)::bigint AS by_doc_date,
            (SELECT COALESCE(SUM(bc2.cents), 0)::bigint
               FROM bill_comm bc2 JOIN recv r2 ON r2.id = bc2.id
              WHERE r2.recv_month = bc.doc_month)::bigint AS by_receipt_date
       FROM bill_comm bc
      GROUP BY 1, 2
      ORDER BY 2`
  );
  const divRows = (divergent.rows as Array<Record<string, unknown>>).filter(
    (r) => Number(r.by_doc_date) !== Number(r.by_receipt_date)
  );
  if (divRows.length === 0) {
    skipped++;
    out(
      "  SKIP  3. document-date attribution — no month where invoice-dating and " +
        "receipt-dating disagree, so the two are not distinguishable in current data\n"
    );
  } else {
    for (const r of divRows) {
      const start = new Date(String(r.m_start));
      const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
      const got = await fetchAgentCommission(db, start.toISOString(), end.toISOString());
      const byDoc = Number(r.by_doc_date);
      const byRecv = Number(r.by_receipt_date);
      if (got.cents === byDoc) {
        out(
          `  PASS  3. ${r.month} = ${usd(byDoc)} by invoice date (receipt-dated would be ${usd(byRecv)})\n`
        );
      } else {
        failed++;
        out(
          `  FAIL  3. ${r.month} expected ${usd(byDoc)} by invoice date, got ${usd(got.cents)}` +
            `${got.cents === byRecv ? " — that is the RECEIPT-dated total; the contract counts by invoice date" : ""}\n`
        );
      }
    }
  }

  out(
    `\n${failed === 0 ? "ALL CHECKS PASS" : `${failed} CHECK(S) FAILED`}` +
      `${skipped > 0 ? ` · ${skipped} skipped (see reasons above)` : ""}\n\n`
  );
  if (failed > 0) process.exitCode = 1;
}
