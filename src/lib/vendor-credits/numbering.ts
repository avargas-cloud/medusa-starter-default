import type { PgClient } from "./types";

/** `custom_vendor_credit_seq` (Migration 1783400000000), same shape as VB-####. */
export async function nextVendorCreditNumber(client: PgClient): Promise<string> {
  const { rows } = await client.query(
    `SELECT 'VC-' || nextval('custom_vendor_credit_seq')::text AS number`
  );
  return (rows[0] as { number: string }).number;
}
