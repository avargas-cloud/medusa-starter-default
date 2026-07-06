/**
 * skip-legacy-cpay-apply-dupes.ts
 *
 * One-shot cleanup for the apply_payment cpay_/papp_ dual-key duplicate class.
 *
 * Finds apply_payment pipeline rows keyed by customer_payment/payment (cpay_) that
 * have a canonical payment_application (papp_) SIBLING row in the same order whose
 * application.payment_id equals the cpay_ row's reference_id and is already
 * in-flight or confirmed. Those cpay_ rows are redundant (the papp_ row is the real
 * one) — mark them 'skipped' so they never dispatch a second ReceivePaymentMod.
 *
 * Idempotent. DRY-RUN by default — prints the candidates and changes nothing.
 * Set APPLY=true (or DRY_RUN=false) to write the skips.
 *
 * QB integrity note: the papp_ sibling is the authoritative apply. A cpay_ row that
 * previously 'confirmed' did so via the IDEMPOTENT read-merge-replace ReceivePayment
 * merge (no second QB document), so marking it 'skipped' is a pipeline-state
 * correction only — it does NOT touch QuickBooks.
 *
 * Run (prod, only AFTER the fix deploy is ACTIVE — not just committed):
 *   set -a; source .env; set +a
 *   # dry run first
 *   npx ts-node src/scripts/fix/skip-legacy-cpay-apply-dupes.ts
 *   # then apply
 *   APPLY=true npx ts-node src/scripts/fix/skip-legacy-cpay-apply-dupes.ts
 */
import { getDbPool } from "../../api/utils/db-pool";

const APPLY =
  process.env.APPLY === "true" || process.env.DRY_RUN === "false";

const SKIP_REASON =
  "apply_payment: superseded by payment_application (papp_) sibling row — legacy cpay_/papp_ dual-key cleanup";

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  if (!url) throw new Error("DATABASE_URL not set");
  console.log(
    `[skip-legacy-cpay-dupes] db=${url.replace(/:[^:@]+@/, ":***@")} mode=${
      APPLY ? "APPLY" : "DRY-RUN"
    }\n`
  );

  const pool = getDbPool();

  // Candidates: cpay_/payment apply_payment rows with a papp_ sibling (in-flight or
  // confirmed) whose application.payment_id == the cpay_ row's reference_id.
  const { rows: candidates } = await pool.query(
    `SELECT DISTINCT
            r.id,
            r.order_id,
            r.reference_id,
            r.reference_type,
            r.status,
            r.medusa_ref_number,
            r.qb_txn_id,
            s.id        AS sibling_id,
            s.status    AS sibling_status,
            s.qb_txn_id AS sibling_txn
       FROM qb_order_pipeline r
       JOIN qb_order_pipeline s
         ON s.order_id       = r.order_id
        AND s.step           = 'apply_payment'
        AND s.reference_type = 'payment_application'
        AND s.status IN ('processing', 'submitted', 'confirmed')
       JOIN payment_application pa
         ON pa.id         = s.reference_id
        AND pa.payment_id = r.reference_id
      WHERE r.step           = 'apply_payment'
        AND r.reference_type IN ('customer_payment', 'payment')
        AND r.status <> 'skipped'
      ORDER BY r.order_id, r.reference_id`
  );

  if (candidates.length === 0) {
    console.log("No legacy cpay_ dual-key rows found. Nothing to do. ✅");
    await pool.end();
    return;
  }

  console.log(`Found ${candidates.length} legacy cpay_ dup row(s):\n`);
  for (const c of candidates) {
    console.log(
      `  row=${c.id} order=${c.order_id} ${c.medusa_ref_number ?? "?"} ` +
        `status=${c.status} cpay=${c.reference_id}\n` +
        `      → superseded by papp_ sibling ${c.sibling_id} (status=${c.sibling_status}, txn=${c.sibling_txn ?? "-"})`
    );
  }

  if (!APPLY) {
    console.log(
      `\nDRY-RUN — no changes written. Re-run with APPLY=true to skip these ${candidates.length} row(s).`
    );
    await pool.end();
    return;
  }

  const ids = candidates.map((c) => c.id);
  const { rowCount } = await pool.query(
    `UPDATE qb_order_pipeline
        SET status     = 'skipped',
            error      = $2,
            updated_at = NOW()
      WHERE id = ANY($1::text[])
        AND status <> 'skipped'`,
    [ids, SKIP_REASON]
  );
  console.log(`\n✅ Skipped ${rowCount} legacy cpay_ dup row(s).`);
  await pool.end();
}

main().catch(async (err) => {
  console.error("[skip-legacy-cpay-dupes] fatal:", err);
  try {
    await getDbPool().end();
  } catch {}
  process.exit(1);
});
