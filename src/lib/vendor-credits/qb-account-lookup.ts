import { VendorCreditError, type PgClient } from "./types";

export interface QbAccountSnapshot {
  full_name: string;
  account_type: string;
}

/**
 * Resolves every distinct `qb_account_list_id` on a set of `qb_account`
 * lines to its `full_name`/`account_type` snapshot, active accounts only.
 * Shared by `create.ts` and `update.ts` — a PATCH that replaces lines must
 * resolve `qb_account` lines exactly the same way a POST does, or a line
 * added by PATCH would silently persist with `qb_account_full_name: null`.
 *
 * Throws `VendorCreditError("account_not_found", …, 400)` for any list id
 * that doesn't resolve — fails closed rather than saving a line whose
 * account snapshot is stale or missing.
 */
export async function resolveQbAccountsByListId(
  client: PgClient,
  listIds: string[]
): Promise<Map<string, QbAccountSnapshot>> {
  const uniqueIds = [...new Set(listIds)];
  if (uniqueIds.length === 0) return new Map();

  const { rows } = await client.query(
    `SELECT qb_list_id, full_name, account_type FROM qb_account
      WHERE qb_list_id = ANY($1::text[]) AND deleted_at IS NULL AND is_active = true`,
    [uniqueIds]
  );
  const accountByListId = new Map<string, QbAccountSnapshot>(
    (rows as { qb_list_id: string; full_name: string; account_type: string }[]).map((r) => [
      r.qb_list_id,
      { full_name: r.full_name, account_type: r.account_type },
    ])
  );

  for (const listId of uniqueIds) {
    if (!accountByListId.has(listId)) {
      throw new VendorCreditError(
        "account_not_found",
        `QB account ${listId} not found or inactive.`
      );
    }
  }

  return accountByListId;
}
