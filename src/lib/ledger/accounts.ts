import type { PoolClient } from "pg";

import { ACCOUNT_MAP_KEYS, AccountMap, LedgerAccount, LedgerError } from "./types";

type MapRow = {
  key: string;
  account_snapshot: {
    id: string;
    name: string;
    account_type: string;
    currency: string;
  };
  normal_balance: string | null;
};

function toAccount(row: MapRow): LedgerAccount {
  const snap = row.account_snapshot;
  return {
    id: snap.id,
    name: snap.name,
    account_type: snap.account_type,
    currency: "USD",
    normal_balance:
      row.normal_balance === "debit" || row.normal_balance === "credit"
        ? row.normal_balance
        : null,
  };
}

/**
 * §3/§5: resuelve las 9 keys de `gl_account_map` contra el snapshot congelado
 * en la fila (no vuelve a leer `qb_account` para currency/type — eso es lo que
 * mantiene la pantalla y el motor sincronizados con lo que un owner aprobó) más
 * el `normal_balance` VIVO de `qb_account` (informativo, no valida contra él).
 */
export async function loadAccountMap(client: PoolClient): Promise<AccountMap> {
  const { rows } = await client.query<MapRow>(
    `SELECT m.key, m.account_snapshot, a.normal_balance
     FROM gl_account_map m
     LEFT JOIN qb_account a ON a.qb_list_id = m.qb_list_id
     WHERE m.key = ANY($1::text[])`,
    [ACCOUNT_MAP_KEYS]
  );
  const found = new Map(rows.map((r) => [r.key, r]));
  const missing = ACCOUNT_MAP_KEYS.filter((k) => !found.has(k));
  if (missing.length) throw new LedgerError("GL_ACCOUNT_MAP_MISSING", { missing });

  const map = {} as AccountMap;
  for (const key of ACCOUNT_MAP_KEYS) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- key viene de ACCOUNT_MAP_KEYS y ya se validó que no falta arriba
    map[key] = toAccount(found.get(key)!);
  }
  return map;
}

/**
 * Cuentas de income/COGS por producto, resueltas por `full_name` contra
 * `qb_account` (identidad de §3). Un producto sin cuenta propia, o cuya cuenta
 * no resuelve/está inactiva, cae al fallback (`income_default`/`cogs_default`)
 * — la resolución NUNCA lanza por un producto individual.
 */
export async function resolveProductAccounts(
  client: PoolClient,
  productIds: string[],
  map: AccountMap
): Promise<Map<string, { income: LedgerAccount; cogs: LedgerAccount }>> {
  const ids = [...new Set(productIds)].filter(Boolean);
  const result = new Map<string, { income: LedgerAccount; cogs: LedgerAccount }>();
  if (!ids.length) return result;

  const { rows } = await client.query<{
    id: string;
    income_full_name: string | null;
    cogs_full_name: string | null;
  }>(
    `SELECT p.id,
       p.metadata->>'qb_income_account_full_name' AS income_full_name,
       p.metadata->>'qb_cogs_account_full_name' AS cogs_full_name
     FROM product p WHERE p.id = ANY($1::text[])`,
    [ids]
  );

  const fullNames = new Set<string>();
  for (const r of rows) {
    if (r.income_full_name) fullNames.add(r.income_full_name);
    if (r.cogs_full_name) fullNames.add(r.cogs_full_name);
  }

  const accountsByName = new Map<string, LedgerAccount>();
  if (fullNames.size) {
    const { rows: accts } = await client.query<{
      full_name: string;
      qb_list_id: string;
      name: string;
      account_type: string;
      normal_balance: string | null;
    }>(
      `SELECT full_name, qb_list_id, name, account_type, normal_balance
       FROM qb_account WHERE full_name = ANY($1::text[]) AND is_active = true`,
      [[...fullNames]]
    );
    for (const a of accts) {
      accountsByName.set(a.full_name, {
        id: a.qb_list_id,
        name: a.name,
        account_type: a.account_type,
        currency: "USD",
        normal_balance:
          a.normal_balance === "debit" || a.normal_balance === "credit"
            ? a.normal_balance
            : null,
      });
    }
  }

  for (const r of rows) {
    const income =
      (r.income_full_name && accountsByName.get(r.income_full_name)) ||
      map.income_default;
    const cogs =
      (r.cogs_full_name && accountsByName.get(r.cogs_full_name)) ||
      map.cogs_default;
    result.set(r.id, { income, cogs });
  }
  return result;
}
