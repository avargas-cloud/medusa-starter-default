/**
 * Consolidates the duplicate store credit created when CM-1026's active QB
 * TxnID was imported while PAY-2333 still pointed at its superseded TxnID.
 *
 * Dry-run by default. Pass --apply only after running against the sandbox.
 */
import "dotenv/config";

import { Client } from "pg";

const ORIGINAL_PAYMENT_ID = "cpay_01KRBDZBSAS5PS1WTC3HHV9351";
const DUPLICATE_PAYMENT_ID = "cpay_01KYA9S0QQWAPA5FA36CAFF6SN";
const CREDIT_MEMO_NUMBER = "CM-1026";
const ACTIVE_QB_TXN_ID = "1C3C04-1778540222";
const ACTIVE_QB_REF_NUMBER = "19510";

interface PaymentRow {
  id: string;
  customer_id: string;
  amount: string;
  status: string;
  reference: string | null;
  display_id: number | null;
  application_count: string;
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");

  const apply = process.argv.includes("--apply");
  const client = new Client({ connectionString });
  await client.connect();

  try {
    await client.query("BEGIN");
    const { rows } = await client.query<PaymentRow>(
      `SELECT cp.id, cp.customer_id, cp.amount::text, cp.status, cp.reference,
              cp.display_id,
              (
                SELECT COUNT(*)::text
                  FROM payment_application pa
                 WHERE pa.payment_id = cp.id
                   AND pa.voided_at IS NULL
                   AND pa.deleted_at IS NULL
              ) AS application_count
         FROM customer_payment cp
        WHERE cp.id = ANY($1::text[])
        FOR UPDATE`,
      [[ORIGINAL_PAYMENT_ID, DUPLICATE_PAYMENT_ID]]
    );

    const original = rows.find((row) => row.id === ORIGINAL_PAYMENT_ID);
    const duplicate = rows.find((row) => row.id === DUPLICATE_PAYMENT_ID);
    if (!original || !duplicate) {
      throw new Error("Expected original and duplicate customer_payment rows");
    }
    if (
      original.customer_id !== duplicate.customer_id ||
      Number(original.amount) !== Number(duplicate.amount)
    ) {
      throw new Error("Payments do not belong to the same customer and amount");
    }
    if (Number(duplicate.application_count) !== 0) {
      throw new Error("Duplicate payment has active applications; aborting");
    }

    const { rows: canonicalRows } = await client.query<{ id: string }>(
      `SELECT q.id
         FROM qb_order_pipeline q
         JOIN pos_credit_memo cm ON cm.id = q.reference_id
        WHERE q.step = 'credit_memo'
          AND q.status = 'confirmed'
          AND q.qb_txn_id = $1
          AND q.qb_ref_number = $2
          AND cm.credit_memo_number = $3
        LIMIT 1`,
      [ACTIVE_QB_TXN_ID, ACTIVE_QB_REF_NUMBER, CREDIT_MEMO_NUMBER]
    );
    if (!canonicalRows[0]) {
      throw new Error("Active QB document is not linked to CM-1026");
    }

    console.log({
      mode: apply ? "apply" : "dry-run",
      keep: {
        id: original.id,
        display_id: original.display_id,
        reference: original.reference,
      },
      retire: {
        id: duplicate.id,
        display_id: duplicate.display_id,
        reference: duplicate.reference,
      },
      active_qb_txn_id: ACTIVE_QB_TXN_ID,
      active_qb_ref_number: ACTIVE_QB_REF_NUMBER,
    });

    if (!apply) {
      await client.query("ROLLBACK");
      return;
    }

    await client.query(
      `UPDATE customer_payment
          SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb,
              qb = COALESCE(qb, '{}'::jsonb) || $3::jsonb,
              updated_at = NOW()
        WHERE id = $1`,
      [
        ORIGINAL_PAYMENT_ID,
        JSON.stringify({
          qb_txn_id: ACTIVE_QB_TXN_ID,
          qb_sync_status: "synced",
          qb_ref_number: ACTIVE_QB_REF_NUMBER,
        }),
        JSON.stringify({ status: "yes", txn_id: ACTIVE_QB_TXN_ID }),
      ]
    );

    await client.query(
      `UPDATE customer_payment
          SET status = 'voided',
              deleted_at = NOW(),
              metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb,
              updated_at = NOW()
        WHERE id = $1`,
      [
        DUPLICATE_PAYMENT_ID,
        JSON.stringify({
          duplicate_consolidated_into: ORIGINAL_PAYMENT_ID,
          duplicate_consolidated_reason:
            "QB credit import matched recreated CM-1026",
        }),
      ]
    );

    await client.query("COMMIT");
    console.log("Consolidation applied successfully");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
