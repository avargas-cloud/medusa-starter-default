/**
 * Verifies the extended QB EditSequence auto-heal (refresh-edit-sequence.ts):
 *   1. stepToCacheEntityType resolves the correct cache key per step,
 *      including the transfer_customer special-case (docType-dependent).
 *   2. The transfer_customer jsonb_set UPDATE is syntactically valid and
 *      scoped safely (run against a non-existent row id — asserts 0 rows
 *      touched, no side effects on real pipeline data).
 *
 * Usage:
 *   env DATABASE_URL=$(grep ^DATABASE_URL= .env | cut -d= -f2-) \
 *     npx medusa exec ./src/scripts/verify/verify-qb-edit-sequence-auto-heal.ts
 */
import { stepToCacheEntityType } from "../../lib/quickbooks/consolidator/refresh-edit-sequence";

export default async function verifyQbEditSequenceAutoHeal({
  container,
}: {
  container: any;
}) {
  const log = (m: string) => console.log(`[verify-editseq-autoheal] ${m}`);
  let failures = 0;

  const cases: Array<[string, string | null | undefined, string]> = [
    ["credit_memo_mod", null, "credit_memo"],
    ["invoice_update", null, "invoice"],
    ["sales_order", null, "sales_order"],
    ["so_close", null, "sales_order"],
    ["so_reopen", null, "sales_order"],
    ["estimate", null, "estimate"],
    ["sales_receipt_update", null, "sales_receipt"],
    ["payment_method_change", null, "payment"],
    ["payment_txndate_change", null, "payment"],
    ["refund_payment_txndate_change", null, "payment"],
    ["refund_check_mod", null, "check"],
    ["transfer_customer", "invoice", "invoice"],
    ["transfer_customer", "sales_order", "sales_order"],
    ["transfer_customer", null, "sales_order"], // defaults to SO when referenceType missing
    ["some_unmapped_step", null, "some_unmapped_step"], // falls back to step name itself
  ];

  for (const [step, refType, expected] of cases) {
    const got = stepToCacheEntityType(step, refType);
    if (got !== expected) {
      failures++;
      log(`❌ stepToCacheEntityType(${step}, ${refType}) = "${got}", expected "${expected}"`);
    } else {
      log(`✅ stepToCacheEntityType(${step}, ${refType}) = "${got}"`);
    }
  }

  // jsonb_set UPDATE syntax + safety check — non-existent id, must affect 0 rows.
  const pg = container.resolve("__pg_connection__") as any;
  const bogusId = "00000000-0000-0000-0000-000000000000"; // qb_order_pipeline.id is uuid
  const result = await pg.raw(
    `UPDATE qb_order_pipeline
        SET payload = jsonb_set(COALESCE(payload, '{}'::jsonb), '{editSequence}', to_jsonb(?::text)),
            next_retry_at = NOW(),
            updated_at = NOW()
      WHERE id = ? AND status = 'failed'`,
    ["FAKE-EDITSEQ-123", bogusId]
  );
  const rowCount = result.rowCount ?? result.rows?.length ?? 0;
  if (rowCount === 0) {
    log(`✅ jsonb_set UPDATE syntax valid, 0 rows touched (bogus id, as expected)`);
  } else {
    failures++;
    log(`❌ jsonb_set UPDATE touched ${rowCount} row(s) for a bogus id — investigate`);
  }

  log(`\n──── Summary ────`);
  log(failures === 0 ? `✅ ALL PASS (${cases.length + 1} checks)` : `❌ ${failures} FAILURE(S)`);
  if (failures > 0) process.exitCode = 1;
}
