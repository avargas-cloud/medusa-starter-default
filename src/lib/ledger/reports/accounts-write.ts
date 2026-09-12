import type { PoolClient } from "pg";
import { ulid } from "ulid";

import { activeEntryPredicate } from "./active-entries";
import { ACCOUNT_TYPE_SET, normalBalanceFor } from "./sections";

export class AccountWriteError extends Error {
  constructor(
    public code: string,
    public status: number,
    message?: string
  ) {
    super(message ?? code);
  }
}

interface ExistingAccount {
  qb_list_id: string;
  name: string;
  full_name: string;
  account_type: string;
  parent_full_name: string | null;
  is_active: boolean;
}

async function loadByListId(
  client: PoolClient,
  listId: string
): Promise<ExistingAccount | null> {
  const { rows } = await client.query<ExistingAccount>(
    `SELECT qb_list_id, name, full_name, account_type, parent_full_name, is_active
       FROM qb_account WHERE qb_list_id = $1 AND deleted_at IS NULL FOR UPDATE`,
    [listId]
  );
  return rows[0] ?? null;
}

async function assertFullNameFree(
  client: PoolClient,
  fullName: string,
  exceptListId?: string
) {
  const { rows } = await client.query<{ qb_list_id: string }>(
    `SELECT qb_list_id FROM qb_account WHERE full_name = $1 AND deleted_at IS NULL`,
    [fullName]
  );
  if (rows.some((r) => r.qb_list_id !== exceptListId)) {
    throw new AccountWriteError(
      "ACCOUNT_NAME_TAKEN",
      409,
      `an account named '${fullName}' already exists`
    );
  }
}

export function validateName(name: unknown): string {
  const value = typeof name === "string" ? name.trim() : "";
  if (!value || value.length > 120 || value.includes(":")) {
    throw new AccountWriteError(
      "INVALID_NAME",
      400,
      "name is required, ≤120 chars, without ':'"
    );
  }
  return value;
}

export interface CreateAccountInput {
  name: string;
  account_type: string;
  parent_list_id: string | null;
  account_number: string | null;
  description: string | null;
}

/**
 * Inserts a POS-owned account into the QB mirror: `qb_list_id = 'pos_' + ulid`
 * (never a QB ListID shape), `full_name = parent.full_name + ':' + name`,
 * normal side derived from the type, `metadata.source = 'pos'` (the table has
 * no source/edit_sequence column and none is added). A sub-account must share
 * its parent's type, as QB requires.
 */
export async function createAccount(
  client: PoolClient,
  input: CreateAccountInput
) {
  if (!ACCOUNT_TYPE_SET.has(input.account_type)) {
    throw new AccountWriteError(
      "INVALID_ACCOUNT_TYPE",
      400,
      `unknown account_type '${input.account_type}'`
    );
  }
  let parent: ExistingAccount | null = null;
  if (input.parent_list_id) {
    parent = await loadByListId(client, input.parent_list_id);
    if (!parent || !parent.is_active) {
      throw new AccountWriteError(
        "PARENT_NOT_FOUND",
        404,
        "parent account not found or inactive"
      );
    }
    if (parent.account_type !== input.account_type) {
      throw new AccountWriteError(
        "PARENT_TYPE_MISMATCH",
        400,
        "a sub-account must share its parent's account_type"
      );
    }
  }
  const fullName = parent ? `${parent.full_name}:${input.name}` : input.name;
  await assertFullNameFree(client, fullName);

  const listId = `pos_${ulid().toLowerCase()}`;
  const metadata: Record<string, unknown> = { source: "pos" };
  if (input.description) metadata.description = input.description;
  await client.query(
    `INSERT INTO qb_account
       (id, qb_list_id, full_name, name, account_type, parent_full_name, parent_list_id,
        account_number, normal_balance, currency, is_active, metadata, last_synced_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'USD', true, $10::jsonb, now())`,
    [
      `qbacc_${ulid()}`,
      listId,
      fullName,
      input.name,
      input.account_type,
      parent?.full_name ?? null,
      parent?.qb_list_id ?? null,
      input.account_number,
      normalBalanceFor(input.account_type),
      JSON.stringify(metadata),
    ]
  );
  return listId;
}

export interface PatchAccountInput {
  name?: string;
  account_number?: string | null;
  is_active?: boolean;
  description?: string | null;
}

/**
 * Rename cascades to every descendant's `full_name`/`parent_full_name`
 * (matched by the old `full_name` prefix, which is how the mirror encodes the
 * tree). Deactivating an account that still carries a balance is refused
 * with `ACCOUNT_HAS_BALANCE` — a report that hides a non-zero account no
 * longer adds up. Accounts are never deleted.
 */
export async function patchAccount(
  client: PoolClient,
  listId: string,
  input: PatchAccountInput
) {
  const current = await loadByListId(client, listId);
  if (!current) throw new AccountWriteError("ACCOUNT_NOT_FOUND", 404);

  if (input.is_active === false && current.is_active) {
    const { rows } = await client.query<{ balance: string }>(
      `SELECT COALESCE(SUM(l.debit_cents - l.credit_cents), 0)::text AS balance
         FROM bank_journal_line l JOIN bank_journal_entry e ON e.id = l.entry_id
        WHERE l.deleted_at IS NULL AND l.account_list_id = $1
          AND ${activeEntryPredicate("e")}`,
      [listId]
    );
    if (BigInt(rows[0]?.balance ?? "0") !== 0n) {
      throw new AccountWriteError(
        "ACCOUNT_HAS_BALANCE",
        409,
        "deactivate requires a zero balance"
      );
    }
  }

  const newName = input.name !== undefined ? input.name : current.name;
  const newFullName = current.parent_full_name
    ? `${current.parent_full_name}:${newName}`
    : newName;
  if (newFullName !== current.full_name) {
    await assertFullNameFree(client, newFullName, listId);
    const oldPrefix = `${current.full_name}:`;
    await client.query(
      `UPDATE qb_account
          SET full_name = $2 || substr(full_name, length($1) + 1),
              parent_full_name = CASE WHEN parent_full_name = $3 THEN $4
                                      ELSE $2 || substr(parent_full_name, length($1) + 1) END,
              updated_at = now()
        WHERE deleted_at IS NULL AND left(full_name, length($1)) = $1`,
      [oldPrefix, `${newFullName}:`, current.full_name, newFullName]
    );
  }

  const metadataPatch: Record<string, unknown> = {};
  if (input.description !== undefined)
    metadataPatch.description = input.description;
  await client.query(
    `UPDATE qb_account
        SET name = $2, full_name = $3,
            account_number = CASE WHEN $4::boolean THEN $5 ELSE account_number END,
            is_active = COALESCE($6::boolean, is_active),
            metadata = COALESCE(metadata, '{}'::jsonb) || $7::jsonb,
            updated_at = now()
      WHERE qb_list_id = $1 AND deleted_at IS NULL`,
    [
      listId,
      newName,
      newFullName,
      input.account_number !== undefined,
      input.account_number ?? null,
      input.is_active ?? null,
      JSON.stringify(metadataPatch),
    ]
  );
}
