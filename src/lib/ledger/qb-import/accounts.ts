/**
 * qb-gl-import — resolutor de cuentas: `FullName` del reporte → `LedgerAccount`
 * desde el espejo `qb_account` (por `full_name`, incluidas las inactivas: una
 * transacción vieja puede pegarle a una cuenta que después se desactivó).
 *
 * Un nombre que no está en el espejo NO se inventa: el documento se bloquea
 * con `unknown_account` y la salida es correr el sync de cuentas
 * (`POST /admin/qb-catalog/accounts/sync`) y reintentar — el import es
 * idempotente por TxnID.
 */
import type { PoolClient } from "pg";
import type { LedgerAccount } from "../types";

type AccountRow = {
  qb_list_id: string;
  full_name: string;
  account_type: string;
  normal_balance: string | null;
};

export type QbAccountIndex = ReadonlyMap<string, LedgerAccount>;

export async function loadQbAccountIndex(client: PoolClient): Promise<QbAccountIndex> {
  const { rows } = await client.query<AccountRow>(
    `SELECT qb_list_id, full_name, account_type, normal_balance
       FROM qb_account
      WHERE deleted_at IS NULL
      ORDER BY is_active DESC, last_synced_at DESC NULLS LAST`
  );
  const index = new Map<string, LedgerAccount>();
  for (const row of rows) {
    if (index.has(row.full_name)) continue; // la activa / más reciente gana
    index.set(row.full_name, {
      id: row.qb_list_id,
      name: row.full_name,
      account_type: row.account_type,
      currency: "USD",
      normal_balance:
        row.normal_balance === "debit" || row.normal_balance === "credit"
          ? row.normal_balance
          : null,
    });
  }
  return index;
}

/** Nombres de cuenta que aparecen en las filas y no resuelven en el espejo (únicos, ordenados). */
export function missingAccounts(
  index: QbAccountIndex,
  accountNames: Iterable<string>
): string[] {
  const missing = new Set<string>();
  for (const name of accountNames) if (!index.has(name)) missing.add(name);
  return [...missing].sort();
}
