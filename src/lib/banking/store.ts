import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { getDbPool } from "../../api/utils/db-pool";
import { BankingError, requireBankingSandbox } from "./security";

export const bankId = (prefix: string) => `${prefix}_${randomUUID().replaceAll("-", "")}`;
export type ConnectionRow = {
  id: string; provider_item_id: string; access_token_encrypted: string | null; cursor: string | null;
  status: string; institution_id: string | null; initial_sync_complete: boolean;
  historical_sync_complete: boolean; sync_requested_at: string | null;
  last_successful_sync_at: Date | null; refresh_requested_at: Date | null;
};

export async function connectionRow(client: PoolClient, id: string): Promise<ConnectionRow> {
  // Preserve Postgres microseconds for the request-marker CAS; JS Date loses them.
  const result = await client.query<ConnectionRow>(`SELECT id,provider_item_id,access_token_encrypted,cursor,status,
    institution_id,initial_sync_complete,historical_sync_complete,
    sync_requested_at::text AS sync_requested_at,last_successful_sync_at,
    refresh_requested_at FROM bank_connection WHERE id=$1 AND environment='sandbox' AND deleted_at IS NULL`, [id]);
  if (!result.rows[0]) throw new BankingError("BANKING_CONNECTION_NOT_FOUND", 404);
  return result.rows[0];
}

/** Session lock also covers network calls. Transaction writes remain short and atomic. */
export async function withBankLock<T>(id: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
  requireBankingSandbox();
  const client = await getDbPool().connect();
  let locked = false;
  let broken = false;
  try {
    const result = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock(hashtextextended($1::text, 7241)) AS locked", [id]);
    locked = result.rows[0]?.locked === true;
    if (!locked) throw new BankingError("BANKING_CONNECTION_BUSY", 409);
    return await work(client);
  } finally {
    if (locked) {
      try { await client.query("SELECT pg_advisory_unlock(hashtextextended($1::text, 7241))", [id]); }
      catch { broken = true; }
    }
    client.release(broken);
  }
}

export async function transaction<T>(client: PoolClient, work: () => Promise<T>): Promise<T> {
  await client.query("BEGIN");
  try {
    const result = await work();
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
