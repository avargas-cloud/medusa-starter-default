import type { PoolClient } from "pg";

import { LedgerError } from "../ledger/types";

/**
 * `sales_tax_settings` (una fila, `id='default'`) + las claves del
 * `gl_account_map` que el módulo usa. El payable es OBLIGATORIO (sin él no
 * hay módulo: `GL_ACCOUNT_MAP_MISSING`); las contrapartidas de los ajustes son
 * defaults opcionales — el ajuste elige cuenta.
 */

export interface SalesTaxSettingsRow {
  tax_item_list_id: string | null;
  tax_item_name: string | null;
  vendor_list_id: string | null;
  vendor_name: string | null;
  default_bank_account_list_id: string | null;
  filing_frequency: "monthly";
  state_rate_bp: number;
  surtax_rate_bp: number;
  variance_tolerance_cents: string;
  updated_by: string | null;
  updated_at: string;
}

export interface SalesTaxAccounts {
  payable_list_id: string;
  adjustment_income_list_id: string | null;
  penalty_expense_list_id: string | null;
}

export interface SalesTaxSettings extends SalesTaxSettingsRow {
  accounts: SalesTaxAccounts;
  /** Listo para pagar: tax item + vendor + payable resueltos. */
  ready: boolean;
  missing: string[];
}

export async function loadSalesTaxSettings(client: PoolClient): Promise<SalesTaxSettings> {
  const { rows } = await client.query<SalesTaxSettingsRow>(
    `SELECT tax_item_list_id, tax_item_name, vendor_list_id, vendor_name, default_bank_account_list_id,
            filing_frequency, state_rate_bp, surtax_rate_bp, variance_tolerance_cents::text, updated_by, updated_at::text
       FROM sales_tax_settings WHERE id = 'default'`
  );
  const row = rows[0];
  if (!row) throw new LedgerError("GL_SOURCE_INVALID", { reason: "sales_tax_settings_missing" });
  const map = await client.query<{ key: string; qb_list_id: string }>(
    `SELECT key, qb_list_id FROM gl_account_map
      WHERE key IN ('sales_tax_payable','sales_tax_adjustment_income','sales_tax_penalty_expense')`
  );
  const byKey = new Map(map.rows.map((r) => [r.key, r.qb_list_id]));
  const payable = byKey.get("sales_tax_payable");
  if (!payable) throw new LedgerError("GL_ACCOUNT_MAP_MISSING", { key: "sales_tax_payable" });
  const missing: string[] = [];
  if (!row.tax_item_list_id) missing.push("tax_item_list_id");
  if (!row.vendor_list_id) missing.push("vendor_list_id");
  return {
    ...row,
    accounts: {
      payable_list_id: payable,
      adjustment_income_list_id: byKey.get("sales_tax_adjustment_income") ?? null,
      penalty_expense_list_id: byKey.get("sales_tax_penalty_expense") ?? null,
    },
    ready: missing.length === 0,
    missing,
  };
}

export interface SalesTaxSettingsPatch {
  tax_item_list_id?: string | null;
  tax_item_name?: string | null;
  vendor_list_id?: string | null;
  vendor_name?: string | null;
  default_bank_account_list_id?: string | null;
  variance_tolerance_cents?: bigint;
}

/** Read-modify-write explícito: sólo las claves presentes cambian. */
export async function saveSalesTaxSettings(
  client: PoolClient,
  patch: SalesTaxSettingsPatch,
  actorId: string
): Promise<SalesTaxSettings> {
  const sets: string[] = [];
  const values: unknown[] = [];
  const push = (col: string, value: unknown) => {
    values.push(value);
    sets.push(`${col} = $${values.length}`);
  };
  if ("tax_item_list_id" in patch) push("tax_item_list_id", patch.tax_item_list_id ?? null);
  if ("tax_item_name" in patch) push("tax_item_name", patch.tax_item_name ?? null);
  if ("vendor_list_id" in patch) push("vendor_list_id", patch.vendor_list_id ?? null);
  if ("vendor_name" in patch) push("vendor_name", patch.vendor_name ?? null);
  if ("default_bank_account_list_id" in patch)
    push("default_bank_account_list_id", patch.default_bank_account_list_id ?? null);
  if (patch.variance_tolerance_cents !== undefined)
    push("variance_tolerance_cents", patch.variance_tolerance_cents.toString());
  push("updated_by", actorId);
  await client.query(
    `UPDATE sales_tax_settings SET ${sets.join(", ")}, updated_at = now() WHERE id = 'default'`,
    values
  );
  return loadSalesTaxSettings(client);
}
