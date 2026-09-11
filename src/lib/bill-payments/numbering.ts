import type { PgClient } from "./types";

/** `custom_bill_payment_seq` (Migration 1783400000000), same shape as VB-####. */
export async function nextBillPaymentNumber(client: PgClient): Promise<string> {
  const { rows } = await client.query(
    `SELECT 'BP-' || nextval('custom_bill_payment_seq')::text AS number`
  );
  return (rows[0] as { number: string }).number;
}
