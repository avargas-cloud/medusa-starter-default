import type { PoolClient } from "pg";
import { BankingError } from "./security";
export const OPENING_TRANSACTION_CLAIM_SQL = `SELECT claim.id,claim.item_id,item.reference FROM bank_opening_clear claim
  JOIN bank_opening_item item ON item.id=claim.item_id WHERE claim.transaction_id=$1 AND claim.kind='clear'
  AND NOT EXISTS(SELECT 1 FROM bank_opening_clear undo WHERE undo.reverses_clear_id=claim.id)`;
export async function assertNoOpeningClear(client: PoolClient, id: string): Promise<void> {
  if ((await client.query(OPENING_TRANSACTION_CLAIM_SQL, [id])).rowCount)
    throw new BankingError("BANKING_OPENING_TRANSACTION_CLAIMED", 409);
}
export async function openingClearProjection<T extends { id: string }>(client: Pick<PoolClient, "query">, rows: T[]): Promise<Array<T & {
  opening_clear?: { id: string; item_id: string; reference: string } }>> {
  const claims = (await client.query<{ id: string; transaction_id: string; item_id: string; reference: string }>(`SELECT claim.id,claim.transaction_id,claim.item_id,item.reference
    FROM bank_opening_clear claim JOIN bank_opening_item item ON item.id=claim.item_id
    WHERE claim.transaction_id=ANY($1::text[]) AND claim.kind='clear'
      AND NOT EXISTS(SELECT 1 FROM bank_opening_clear undo WHERE undo.reverses_clear_id=claim.id)`, [rows.map(row => row.id)])).rows;
  return rows.map(row => { const claim = claims.find(c => c.transaction_id === row.id);
    return claim ? { ...row, opening_clear: { id: claim.id, item_id: claim.item_id, reference: claim.reference } } : row; });
}
