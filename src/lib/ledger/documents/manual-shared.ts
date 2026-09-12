import type { PoolClient } from "pg";
import { ulid } from "ulid";

import { getBusinessDateString } from "../../date/et";
import { LedgerAccount, LedgerError } from "../types";

/**
 * Infraestructura común de los documentos MANUALES del GL (`gl_journal_entry`,
 * `gl_check`, `gl_transfer`): ids, numeración gapless, snapshots de cuenta
 * y el día de la reversa. Nada acá conoce la forma de un documento concreto.
 */

export type GlDocumentStatus = "draft" | "posted" | "voided";

/** Lo que se persiste en `*_snapshot` del documento y viaja al POS. */
export interface AccountSnapshot {
  id: string;
  name: string;
  account_type: string;
}

export function newGlId(
  prefix: "gje" | "gjel" | "gchk" | "gchkl" | "gtr"
): string {
  return `${prefix}_${ulid()}`;
}

export type GlCounterName = "gl_journal_entry" | "gl_check" | "gl_transfer";

/**
 * Espejo pg (`$1`) de `allocateNextNumber` (`lib/invoices/document-numbering.ts`,
 * knex `?`): `UPDATE … RETURNING` toma el row lock y se deshace con la
 * transacción del caller — un INSERT fallido nunca quema un número.
 */
export async function allocateGlNumber(
  client: PoolClient,
  name: GlCounterName,
  prefix: "JE" | "CHK" | "TR"
): Promise<string> {
  const { rows } = await client.query<{ value: string }>(
    `UPDATE document_number_counter SET value = value + 1, updated_at = now()
     WHERE name = $1 RETURNING value::text`,
    [name]
  );
  const value = rows[0]?.value;
  if (!value)
    throw new Error(
      `[gl-docs] counter '${name}' is missing — run migration 1789300000000`
    );
  return `${prefix}-${value.padStart(4, "0")}`;
}

type AccountRow = {
  qb_list_id: string;
  full_name: string;
  account_type: string;
  normal_balance: string | null;
};

function toLedgerAccount(row: AccountRow): LedgerAccount {
  return {
    id: row.qb_list_id,
    name: row.full_name,
    account_type: row.account_type,
    currency: "USD",
    normal_balance:
      row.normal_balance === "debit" || row.normal_balance === "credit"
        ? row.normal_balance
        : null,
  };
}

/**
 * Cuentas ACTIVAS por `qb_list_id`. Falla cerrado: una sola id inactiva,
 * borrada o inexistente rechaza el documento entero (`account_not_active`),
 * nunca se postea contra un snapshot de una cuenta que ya no existe.
 */
export async function loadActiveAccounts(
  client: PoolClient,
  listIds: string[]
): Promise<Map<string, LedgerAccount>> {
  const unique = [...new Set(listIds)];
  if (unique.length === 0) return new Map();
  const { rows } = await client.query<AccountRow>(
    `SELECT qb_list_id, full_name, account_type, normal_balance
     FROM qb_account
     WHERE qb_list_id = ANY($1::text[]) AND is_active = true AND deleted_at IS NULL
       AND account_type <> 'NonPosting'`,
    [unique]
  );
  const map = new Map(rows.map((r) => [r.qb_list_id, toLedgerAccount(r)]));
  const missing = unique.filter((id) => !map.has(id));
  if (missing.length)
    throw new LedgerError("GL_SOURCE_INVALID", {
      reason: "account_not_active",
      account_list_ids: missing,
    });
  return map;
}

export function toAccountSnapshot(account: LedgerAccount): AccountSnapshot {
  return {
    id: account.id,
    name: account.name,
    account_type: account.account_type,
  };
}

/** `AccountSnapshot` persistido → `LedgerAccount` (con normal_balance null, que el motor no exige). */
export function snapshotToLedgerAccount(
  snapshot: AccountSnapshot
): LedgerAccount {
  return { ...snapshot, currency: "USD", normal_balance: null };
}

/**
 * Día de la reversa: hoy (ET), salvo que el asiento original sea POSTERIOR —
 * `gl_document_source_unique` rechaza `NEW.day < original.day` (mismo
 * criterio que `reverseOpeningBalance`).
 */
export function reversalDay(originalDay: string): string {
  const today = getBusinessDateString();
  return originalDay > today ? originalDay : today;
}

export function assertStatus(
  status: GlDocumentStatus,
  expected: GlDocumentStatus,
  id: string
): void {
  if (status === expected) return;
  throw new LedgerError(
    expected === "draft" ? "GL_DOCUMENT_NOT_DRAFT" : "GL_DOCUMENT_NOT_POSTED",
    { id, status }
  );
}
