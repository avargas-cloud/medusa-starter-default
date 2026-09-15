/**
 * qb-vendor-credit-apply-accounts.ts
 *
 * Account lookups for `qb-vendor-credit-apply-enqueue.ts`, split out to keep
 * that file under the repo's 300-line cap. Pure DB reads, no QBXML, no
 * business decisions — the caller decides what a missing account means.
 */

import type { PurchaseDependencyKnex } from "./qb-purchase-dependency-chain";

export type AccountLookupKnex = PurchaseDependencyKnex;

export async function loadApAccountListId(
  knex: AccountLookupKnex
): Promise<string | null> {
  const result = await knex.raw(
    `SELECT qb_list_id FROM gl_account_map WHERE key = 'accounts_payable' LIMIT 1`
  );
  return (
    (result.rows[0] as { qb_list_id?: string } | undefined)?.qb_list_id ?? null
  );
}

/**
 * A $0 Pay Bills still needs a CreditCardAccountRef in the XML even though
 * no money actually moves through it — operator decision (09/15): any
 * CreditCard account works, so the credit's own account line is preferred
 * (reads naturally in QB's Pay Bills history) and any active CreditCard
 * account is the fallback.
 */
export async function loadCreditCardAccountListId(
  knex: AccountLookupKnex,
  creditId: string
): Promise<string | null> {
  const lineResult = await knex.raw(
    `SELECT qa.qb_list_id
       FROM vendor_credit_line vcl
       JOIN qb_account qa ON qa.qb_list_id = vcl.qb_account_list_id
      WHERE vcl.credit_id = ? AND vcl.deleted_at IS NULL
        AND vcl.line_type = 'qb_account' AND qa.account_type = 'CreditCard'
      ORDER BY vcl.sort ASC, vcl.created_at ASC
      LIMIT 1`,
    [creditId]
  );
  const fromLine = (lineResult.rows[0] as { qb_list_id?: string } | undefined)
    ?.qb_list_id;
  if (fromLine) return fromLine;

  const fallbackResult = await knex.raw(
    `SELECT qb_list_id FROM qb_account
      WHERE account_type = 'CreditCard' AND is_active
      ORDER BY full_name ASC
      LIMIT 1`
  );
  return (
    (fallbackResult.rows[0] as { qb_list_id?: string } | undefined)
      ?.qb_list_id ?? null
  );
}

/** Best-effort single pointer for the UI — see `qb-bill-payment-enqueue.ts`'s twin for why this is not the real gate. */
export async function findBlockingAddOperationId(
  knex: AccountLookupKnex,
  blockingReferenceId: string
): Promise<string | null> {
  const result = await knex.raw(
    `SELECT id FROM qb_order_pipeline
      WHERE reference_id = ? AND step IN ('vendor_credit_add', 'vendor_bill_add')
      ORDER BY created_at DESC LIMIT 1`,
    [blockingReferenceId]
  );
  return (result.rows[0] as { id?: string } | undefined)?.id ?? null;
}
