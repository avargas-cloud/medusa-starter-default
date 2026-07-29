/**
 * verify-apply-payment-quiescence
 *
 * Replays every historical credit-memo `apply_payment` through the REAL
 * quiescence gate and checks that its verdict matches what actually happened in
 * QuickBooks.
 *
 * The claim being verified here is the FALSE-POSITIVE side: the gate must not
 * delay an apply that would have succeeded. A gate that blocks healthy traffic
 * is worse than the bug it prevents, so this script turns red if any historical
 * success would have been held back.
 *
 * The other half — that the gate CATCHES the CM-1105 → Invoice 21215 incident
 * (QB Error 3210, 2026-07-27) — is locked in by the unit test
 * `src/__tests__/qb-apply-quiescence/document-quiescence.unit.spec.ts`, not
 * here. It cannot be replayed from the table anymore: that row was repaired on
 * 2026-07-28 by re-dispatching it, which overwrote its `submitted_at` and
 * `failed_at` with the repair timestamps. The historical failure instant is
 * gone from the data by design — the fix consumed the evidence.
 *
 * Read-only — it evaluates the gate against a historical snapshot, it never
 * dispatches, defers or writes anything.
 *
 * Run:
 *   env DATABASE_URL=$(grep ^DATABASE_URL= .env | cut -d= -f2-) \
 *     ./node_modules/.bin/tsx src/scripts/verify/verify-apply-payment-quiescence.ts
 */
import { Client } from "pg";

import {
  CREDIT_MEMO_MUTATION_STEPS,
  INVOICE_MUTATION_STEPS,
  type PipelineOperationRow,
} from "../../lib/quickbooks/pipeline/document-quiescence";

type ApplyRow = {
  id: string;
  status: string;
  /**
   * The instant the apply actually went to the bridge — NOT `created_at`.
   *
   * An apply_payment row is written in the same transaction as its invoice row,
   * so at `created_at` the invoice ADD is always still in flight. Using it as
   * the reference instant makes every historical apply look blocked by its own
   * invoice. The gate never sees that state: the pre-existing existence check
   * parks the apply until the invoice has a TxnID.
   */
  dispatched_at: Date;
  medusa_ref_number: string | null;
  invoice_id: string;
  cm_ref: string | null;
};

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");
  const client = new Client({ connectionString });
  await client.connect();

  try {
    const { rows: applies } = await client.query<ApplyRow>(
      `SELECT p.id, p.status, p.medusa_ref_number,
              COALESCE(p.submitted_at, p.failed_at, p.confirmed_at, p.created_at)
                AS dispatched_at,
              pa.invoice_id, cp.reference AS cm_ref
         FROM qb_order_pipeline p
         JOIN payment_application pa ON pa.id = p.reference_id
         JOIN customer_payment cp    ON cp.id = pa.payment_id
        WHERE p.step = 'apply_payment'
          AND cp.type = 'credit_memo'
        ORDER BY p.created_at DESC`
    );

    console.log(
      `Replaying ${applies.length} credit-memo apply_payment rows through the gate.\n`
    );

    let wouldBlock = 0;
    let blockedAndFailed = 0;
    let blockedButSucceeded = 0;
    let allowedAndFailed = 0;

    for (const a of applies) {
      // Reconstruct the state of both documents AS OF the moment this apply
      // was dispatched: operations that already existed and had not yet settled.
      // A mutation was LIVE at instant T if it already existed and had not yet
      // confirmed by then. `skipped` rows never ran, so they never blocked.
      const { rows: blockers } = await client.query<PipelineOperationRow>(
        `SELECT m.id, m.step, m.status, m.reference_id, m.medusa_ref_number,
                m.next_retry_at
           FROM qb_order_pipeline m
           LEFT JOIN pos_credit_memo cm ON cm.id = m.reference_id
          WHERE m.id <> $1
            AND m.created_at < $2
            AND (m.confirmed_at IS NULL OR m.confirmed_at > $2)
            AND m.status <> 'skipped'
            AND (
                  (m.step = ANY($3::text[]) AND m.reference_id = $4)
               OR ($5::text IS NOT NULL
                   AND m.step = ANY($6::text[])
                   AND cm.credit_memo_number = $5)
            )`,
        [
          a.id,
          a.dispatched_at,
          INVOICE_MUTATION_STEPS,
          a.invoice_id,
          a.cm_ref,
          CREDIT_MEMO_MUTATION_STEPS,
        ]
      );

      if (blockers.length > 0) {
        wouldBlock++;
        const label = `${a.medusa_ref_number ?? a.id} (${a.status})`;
        const detail = blockers
          .map((b) => `${b.step}[${b.status}]`)
          .join(", ");
        if (a.status === "failed") {
          blockedAndFailed++;
          console.log(`  ✅ WOULD HAVE PREVENTED  ${label} — blocked by ${detail}`);
        } else {
          blockedButSucceeded++;
          console.log(`  ⏳ would have delayed    ${label} — blocked by ${detail}`);
        }
      } else if (a.status === "failed") {
        allowedAndFailed++;
        console.log(
          `  ⚠️  gate would NOT have caught ${a.medusa_ref_number ?? a.id} (failed for another reason)`
        );
      }
    }

    console.log("\n──────────── summary ────────────");
    console.log(`  applies examined         : ${applies.length}`);
    console.log(`  gate would have blocked  : ${wouldBlock}`);
    console.log(`    ↳ of which DID fail    : ${blockedAndFailed}`);
    console.log(`    ↳ of which succeeded   : ${blockedButSucceeded}`);
    console.log(`  failures gate would miss : ${allowedAndFailed}`);

    if (blockedButSucceeded > 0) {
      console.error(
        `\n❌ FAIL — ${blockedButSucceeded} apply(s) that SUCCEEDED would have been ` +
          `deferred by the gate. A gate that delays healthy traffic is worse than the ` +
          `race it prevents. Tighten the predicate in document-quiescence.ts.`
      );
      process.exitCode = 1;
      return;
    }

    console.log(
      "\n✅ PASS — no historical apply that succeeded would have been delayed."
    );
    console.log(
      "   (That the gate CATCHES the CM-1105 race is covered by the unit test —" +
        " see the header of this file for why it cannot be replayed from the table.)"
    );
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
