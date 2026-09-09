import type { PoolClient } from "pg";

import { getDbPool } from "../../api/utils/db-pool";

import { BankingError, bankingConfig } from "./security";

export type BankingControl = {
  enabled: boolean;
  reason: string | null;
  updated_by: string | null;
  updated_at: Date | null;
};

type Queryable = Pick<PoolClient, "query">;

/** Sandbox tolerates the table being absent (its schema is applied by the approved runner, not by db:migrate);
 *  production fails CLOSED without it, because the deploy must have created it before the first request. */
export async function readBankingControl(
  client: Queryable = getDbPool()
): Promise<BankingControl> {
  const exists = await client.query<{ name: string | null }>(
    "SELECT to_regclass('public.bank_control') AS name"
  );
  if (!exists.rows[0]?.name) {
    if (bankingConfig().environment === "production")
      throw new BankingError("BANKING_CONTROL_MISSING", 503);
    return { enabled: true, reason: null, updated_by: null, updated_at: null };
  }
  const row = (
    await client.query<BankingControl>(
      "SELECT enabled,reason,updated_by,updated_at FROM bank_control WHERE id='default'"
    )
  ).rows[0];
  if (!row) {
    if (bankingConfig().environment === "production")
      throw new BankingError("BANKING_CONTROL_MISSING", 503);
    return { enabled: true, reason: null, updated_by: null, updated_at: null };
  }
  return row;
}

/** Called under every bank/review lock and before each job batch, so a pause stops new work within one operation. */
export async function assertBankingControl(
  client: Queryable = getDbPool()
): Promise<void> {
  if (!(await readBankingControl(client)).enabled)
    throw new BankingError("BANKING_PAUSED", 503);
}

export async function setBankingControl(
  actorId: string,
  enabled: boolean,
  reason: string | null
): Promise<BankingControl> {
  const exists = await getDbPool().query<{ name: string | null }>(
    "SELECT to_regclass('public.bank_control') AS name"
  );
  if (!exists.rows[0]?.name)
    throw new BankingError("BANKING_CONTROL_MISSING", 503);
  const row = (
    await getDbPool().query<BankingControl>(
      `UPDATE bank_control SET enabled=$1,reason=$2,updated_by=$3,updated_at=now()
    WHERE id='default' RETURNING enabled,reason,updated_by,updated_at`,
      [enabled, reason, actorId]
    )
  ).rows[0];
  if (!row) throw new BankingError("BANKING_CONTROL_MISSING", 503);
  return row;
}
