import type { PoolClient } from "pg";

import {
  ACCOUNT_MAP_KEYS,
  AccountMap,
  LedgerAccount,
  LedgerError,
  OPENING_ACCOUNT_MAP_KEYS,
  OpeningAccountMap,
  PURCHASE_ACCOUNT_MAP_KEYS,
  PurchaseAccountMap,
} from "./types";

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
 * Las 9 keys históricas de `gl_account_map` — el default de `loadAccountMap`
 * cuando el caller no pide un subconjunto explícito. `opening_balance_equity`
 * (Banking-on-GL §2/§6) queda AFUERA a propósito: sólo la exige quien postea
 * `opening_balance`, así que un ambiente sin esa fila sembrada no rompe los
 * documentos existentes — la key es opcional para todo lo demás.
 */
async function loadAccountMapByKeys(
  client: PoolClient,
  keys: readonly string[]
): Promise<Record<string, LedgerAccount>> {
  const { rows } = await client.query<MapRow>(
    `SELECT m.key, m.account_snapshot, a.normal_balance
     FROM gl_account_map m
     LEFT JOIN qb_account a ON a.qb_list_id = m.qb_list_id
     WHERE m.key = ANY($1::text[])`,
    [keys]
  );
  const found = new Map(rows.map((r) => [r.key, r]));
  const missing = keys.filter((k) => !found.has(k));
  if (missing.length) throw new LedgerError("GL_ACCOUNT_MAP_MISSING", { missing });

  const map: Record<string, LedgerAccount> = {};
  for (const key of keys) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- key viene de `keys` y ya se validó que no falta arriba
    map[key] = toAccount(found.get(key)!);
  }
  return map;
}

export async function loadAccountMap(client: PoolClient): Promise<AccountMap> {
  return (await loadAccountMapByKeys(client, ACCOUNT_MAP_KEYS)) as AccountMap;
}

/**
 * gl-purchases-v2 §2/§3: los documentos de compras necesitan además
 * `accounts_payable`/`inventory_offset` (`PURCHASE_ACCOUNT_MAP_KEYS`, ver el
 * comentario en `types.ts` sobre por qué esas dos NO entran a `ACCOUNT_MAP_KEYS`
 * — un ambiente sin sembrarlas no debe romper plan-1). Una sola query trae
 * las 9+2 keys.
 */
/** Banking-on-GL: las 9 keys + `opening_balance_equity`; sólo lo pide `postOpeningBalance`. */
export async function loadOpeningAccountMap(
  client: PoolClient
): Promise<OpeningAccountMap> {
  const keys = [...ACCOUNT_MAP_KEYS, ...OPENING_ACCOUNT_MAP_KEYS];
  return (await loadAccountMapByKeys(client, keys)) as OpeningAccountMap;
}

export async function loadPurchaseAccountMap(
  client: PoolClient
): Promise<PurchaseAccountMap> {
  const keys = [...ACCOUNT_MAP_KEYS, ...PURCHASE_ACCOUNT_MAP_KEYS];
  return (await loadAccountMapByKeys(client, keys)) as PurchaseAccountMap;
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
