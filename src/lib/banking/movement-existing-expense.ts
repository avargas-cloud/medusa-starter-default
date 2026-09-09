import type { PoolClient } from "pg";

import { BankingError } from "./security";

/** Only explicit document identities establish prior ownership; amounts/names alone do not. */
export function movementExistingExpenseSql(reference = "$1::text"): string {
  const ref = `lower(${reference})`;
  return `SELECT id FROM bank_journal_entry WHERE kind<>'reversal'
      AND (${ref}=lower(id) OR ${ref}=lower('journal:'||id) OR ${ref}=lower(expense_id) OR ${ref}=lower('expense:'||expense_id))
    UNION ALL SELECT id FROM vendor_bill WHERE deleted_at IS NULL AND (${ref}=lower(id) OR ${ref}=lower('vendor_bill:'||id))
    UNION ALL SELECT id FROM china_wire_transfer WHERE ${ref}=lower(id) OR ${ref}=lower('wire:'||id)
    UNION ALL SELECT month FROM pos_monthly_payroll WHERE ${ref} IN ('payroll:'||month,'payroll:'||month||':15',
      'payroll:'||month||':'||LEAST(30,extract(day FROM (month||'-01')::date+interval '1 month'-interval '1 day')::integer)::text)
    UNION ALL SELECT id FROM bank_direct_expense WHERE deleted_at IS NULL AND (${ref}=lower(id) OR ${ref}=lower('expense:'||id))
    UNION ALL SELECT id FROM customer_payment WHERE deleted_at IS NULL AND
      (type='refund' OR status IN ('refunded','partial_refunded')) AND (${ref}=lower(id) OR ${ref}=lower('refund:'||id)) LIMIT 1`;
}
export async function assertMovementNewExpense(
  client: PoolClient,
  reference: string
): Promise<void> {
  if ((await client.query(movementExistingExpenseSql(), [reference])).rowCount)
    throw new BankingError("BANKING_MOVEMENT_EXPENSE_ALREADY_RECOGNIZED", 409);
}
