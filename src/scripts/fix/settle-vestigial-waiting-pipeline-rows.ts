/**
 * scripts/fix/settle-vestigial-waiting-pipeline-rows.ts
 *
 * Settles qb_order_pipeline rows parked in 'waiting' forever with no work left
 * to do. They are harmless to the pipeline (the consolidator only claims
 * 'pending'), but they pollute every "is anything stuck?" query — which is
 * exactly the cost that triggered this script (2026-07-23).
 *
 * NEITHER rescue pass can reach them:
 *   - runWakeDependentsPass requires the depends_on parent to be 'confirmed'
 *     (dispatch-pass.ts:93) — a parent left 'fixed'/'skipped'/'failed' never
 *     wakes its children.
 *   - runOrphanedWaitingPass only covers depends_on IS NULL AND step='payment'.
 *
 * Two profiles, each PROVEN per row — never assumed:
 *
 *   A) sales_order waiting for a CANCELED order. Requires: no depends_on, no
 *      payload, no qb_txn_id (this row never created anything in QB), the order
 *      is canceled, AND the order has at least one CONFIRMED document sibling
 *      (sales_receipt/invoice) — so we know QB did get the sale and this row is
 *      genuinely spare, not the only thing that never ran.
 *
 *   B) apply_payment waiting whose parent can never confirm, superseded by a
 *      CONFIRMED apply_payment row on the same order. Requires the confirmed
 *      sibling to exist — without it we would be hiding real unapplied money.
 *
 * Anything that does not match a profile exactly is REPORTED AND SKIPPED, never
 * guessed. Touches no QuickBooks document: only the pipeline bookkeeping row.
 *
 * DRY-RUN BY DEFAULT. Pass --apply to write.
 *
 * Run: ./node_modules/.bin/tsx src/scripts/fix/settle-vestigial-waiting-pipeline-rows.ts
 *      ./node_modules/.bin/tsx src/scripts/fix/settle-vestigial-waiting-pipeline-rows.ts --apply
 */

import { Client } from "pg";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.join(__dirname, "../../../.env") });

const APPLY = process.argv.includes("--apply");

const REASON_A =
  "Order canceled — sale closed via SR/Invoice and its void is confirmed in QB; this sales_order row never had a payload and has nothing to do";
const REASON_B =
  "Superseded by a confirmed retry row on the same order; depends_on parent is not 'confirmed' so it can never wake";

type Row = {
  id: string;
  step: string;
  order_id: string | null;
  display_id: number | null;
  medusa_ref_number: string | null;
  reference_id: string | null;
  has_depends_on: boolean;
  parent_status: string | null;
  has_payload: boolean;
  qb_txn_id: string | null;
  order_canceled: boolean;
  confirmed_doc_siblings: number;
  confirmed_same_step_siblings: number;
  age: string;
};

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  console.log(
    APPLY
      ? "⚠️  APPLY MODE — changes WILL be written.\n"
      : "🔎 DRY RUN — no changes will be written. Pass --apply to commit.\n"
  );

  try {
    const { rows } = await client.query<Row>(`
      SELECT p.id,
             p.step,
             p.order_id,
             o.display_id,
             p.medusa_ref_number,
             p.reference_id,
             (p.depends_on IS NOT NULL)          AS has_depends_on,
             d.status                            AS parent_status,
             (p.payload IS NOT NULL)             AS has_payload,
             p.qb_txn_id,
             (o.canceled_at IS NOT NULL)         AS order_canceled,
             (SELECT COUNT(*) FROM qb_order_pipeline s
               WHERE s.order_id = p.order_id
                 AND s.status = 'confirmed'
                 AND s.step IN ('sales_receipt','invoice','sales_order','credit_memo')
             )::int                              AS confirmed_doc_siblings,
             (SELECT COUNT(*) FROM qb_order_pipeline s
               WHERE s.order_id = p.order_id
                 AND s.status = 'confirmed'
                 AND s.step = p.step
             )::int                              AS confirmed_same_step_siblings,
             age(NOW(), p.created_at)::text      AS age
        FROM qb_order_pipeline p
        LEFT JOIN "order" o             ON o.id = p.order_id
        LEFT JOIN qb_order_pipeline d   ON d.id = p.depends_on
       WHERE p.status = 'waiting'
       ORDER BY p.created_at
    `);

    if (rows.length === 0) {
      console.log("Nothing to do — no 'waiting' rows.");
      return;
    }

    console.log(`Found ${rows.length} 'waiting' row(s).\n`);

    const toSettle: { id: string; reason: string; label: string }[] = [];
    let skipped = 0;

    for (const r of rows) {
      const label = `${r.step} ${r.medusa_ref_number ?? r.reference_id ?? r.id.slice(0, 8)}${
        r.display_id ? ` (order ${r.display_id})` : ""
      }`;
      console.log(`── ${label} — waiting ${r.age.split(".")[0]}`);

      // ── Profile A ────────────────────────────────────────────────────────
      const profileA =
        r.step === "sales_order" &&
        !r.has_depends_on &&
        !r.has_payload &&
        !r.qb_txn_id &&
        r.order_canceled &&
        r.confirmed_doc_siblings > 0;

      // ── Profile B ────────────────────────────────────────────────────────
      const profileB =
        r.step === "apply_payment" &&
        !r.qb_txn_id &&
        r.parent_status !== null &&
        r.parent_status !== "confirmed" &&
        r.confirmed_same_step_siblings > 0;

      if (profileA) {
        console.log(
          `   ✔ profile A — order canceled, ${r.confirmed_doc_siblings} confirmed doc sibling(s), no payload, no qb_txn_id`
        );
        toSettle.push({ id: r.id, reason: REASON_A, label });
      } else if (profileB) {
        console.log(
          `   ✔ profile B — parent is '${r.parent_status}' (never wakes), ${r.confirmed_same_step_siblings} confirmed ${r.step} sibling(s) on the same order`
        );
        toSettle.push({ id: r.id, reason: REASON_B, label });
      } else {
        console.log(
          `   ⏭️  SKIPPED — matches no profile exactly. step=${r.step} canceled=${r.order_canceled} ` +
            `parent=${r.parent_status ?? "none"} payload=${r.has_payload} txn=${r.qb_txn_id ?? "none"} ` +
            `docSibs=${r.confirmed_doc_siblings} sameStepSibs=${r.confirmed_same_step_siblings}. Resolve by hand.`
        );
        skipped++;
      }
    }

    console.log(
      `\n${APPLY ? "Settling" : "Would settle"}: ${toSettle.length} · Skipped: ${skipped}`
    );

    if (APPLY && toSettle.length > 0) {
      for (const s of toSettle) {
        await client.query(
          `UPDATE qb_order_pipeline
              SET status        = 'skipped',
                  error         = $2,
                  next_retry_at = NULL,
                  updated_at    = NOW()
            WHERE id = $1 AND status = 'waiting'`,
          [s.id, s.reason]
        );
        console.log(`   ✅ settled ${s.label}`);
      }
    } else if (!APPLY && toSettle.length > 0) {
      console.log("Re-run with --apply to commit.");
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
