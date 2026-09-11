import type { PoolClient } from "pg";

import { assertBankAccountingPeriodOpen } from "../accounting/banking-period-lock";
import { pgDateToIso } from "../date/et";

import { BillPaymentError, type PgClient } from "./types";

interface PaymentRow {
  id: string;
  status: string;
  // pg `date` column → JS Date (local-midnight). See vendor-credits/post.ts's note.
  payment_date: Date | string;
}

/**
 * Voids a posted payment. Allocations are never deleted (plan invariant:
 * "voids: set voided_* and release allocations/applications, never delete
 * rows") — releasing here means the bills' balances recompute back up the
 * moment `computeBillBalance` filters allocations by `p.status = 'posted'`.
 */
export async function voidBillPayment(
  client: PgClient,
  paymentId: string,
  actorId: string,
  reason?: string | null
): Promise<void> {
  await client.query("BEGIN");
  try {
    const { rows } = await client.query(
      `SELECT id, status, payment_date FROM vendor_bill_payment
        WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
      [paymentId]
    );
    const payment = rows[0] as PaymentRow | undefined;
    if (!payment) throw new BillPaymentError("not_found", "Bill payment not found.", 404);
    if (payment.status !== "posted") {
      throw new BillPaymentError("invalid_status", `Bill payment is ${payment.status}, expected posted.`, 409);
    }

    await assertBankAccountingPeriodOpen(
      client as unknown as PoolClient,
      pgDateToIso(payment.payment_date)
    );

    await client.query(
      `UPDATE vendor_bill_payment SET status='voided', voided_at=now(), voided_by=$2, voided_reason=$3, updated_at=now()
        WHERE id=$1`,
      [paymentId, actorId, reason ?? null]
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  }
}
