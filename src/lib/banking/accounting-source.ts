import type { PoolClient } from "pg";

import {
  bankExpenseCents,
  type AccountingAccount,
  type AccountingSource,
} from "./accounting-types";
import { OPENING_TRANSACTION_CLAIM_SQL } from "./opening-guards";
import { receiptMapping, receiptSetup } from "./receipts-setup";
import { reviewHash } from "./review-common";
import { reviewDate, reviewToday } from "./review-date";
import { BankingError, bankingEnvSql } from "./security";

type SourceRow = {
  id: string;
  account_id: string;
  account_name: string;
  transaction_date: string;
  name: string;
  amount: string;
  currency: string | null;
  source_version: number;
  status: string;
  deleted: boolean;
  account_currency: string | null;
  account_type: string;
  is_active: boolean;
  is_selected: boolean;
  review_start_date: string | null;
  opening_reference: string | null;
  opening_bank_balance: string | null;
  review_revision: number;
  review_source_version: number | null;
  review_status: string | null;
  mode: string | null;
  category_list_id: string | null;
  qb_list_id: string | null;
  counterparty_id: string | null;
  counterparty_type: string | null;
  category_snapshot: AccountingAccount | null;
  rule_id: string | null;
  rule_version: number | null;
  current_rule_version: number | null;
  current_rule_active: boolean | null;
  comment: string | null;
  day_closed: boolean;
  closed_review_revision: number | null;
};
export type SourceContext = {
  source: AccountingSource;
  source_hash: string;
  snapshot: unknown;
  blockers: string[];
  counterparty_id: string | null;
  counterparty_type: string | null;
};

/** Caller holds banking-review. Closed daily evidence can be posted; no open-day guard belongs here. */
export async function accountingSource(
  client: PoolClient,
  id: string
): Promise<SourceContext> {
  const row = (
    await client.query<SourceRow>(
      `SELECT t.id,t.account_id,a.name AS account_name,t.transaction_date,
    t.name,t.amount,t.currency,t.source_version,t.status,
    (t.deleted_at IS NOT NULL OR a.deleted_at IS NOT NULL OR c.deleted_at IS NOT NULL) AS deleted,
    a.currency AS account_currency,a.type AS account_type,a.is_active,a.is_selected,
    a.review_start_date,a.opening_reference,a.opening_bank_balance,
    COALESCE(r.revision,0) AS review_revision,r.source_version AS review_source_version,r.status AS review_status,
    r.mode,r.category_list_id,a.qb_list_id,r.counterparty_id,r.counterparty_type,r.category_snapshot,
    r.rule_id,r.rule_version,rr.version AS current_rule_version,rr.active AS current_rule_active,r.comment,
    COALESCE(dc.status='closed',false) AS day_closed,
    (SELECT (st->'review'->>'revision')::integer FROM jsonb_array_elements(COALESCE(dc.snapshot->'accounts','[]')) sa,
      jsonb_array_elements(COALESCE(sa->'transactions','[]')) st WHERE st->>'id'=t.id LIMIT 1) AS closed_review_revision
    FROM bank_transaction t JOIN bank_account a ON a.id=t.account_id JOIN bank_connection c ON c.id=a.connection_id
    LEFT JOIN bank_transaction_review r ON r.transaction_id=t.id AND r.deleted_at IS NULL
    LEFT JOIN bank_review_rule rr ON rr.id=r.rule_id AND rr.deleted_at IS NULL
    LEFT JOIN bank_day_close dc ON dc.day=t.transaction_date AND dc.deleted_at IS NULL
    WHERE t.id=$1 AND c.environment=${bankingEnvSql()} FOR SHARE OF t,a,c`,
      [id]
    )
  ).rows[0];
  if (!row) throw new BankingError("BANKING_TRANSACTION_NOT_FOUND", 404);
  const attested = (await receiptSetup(client))?.attested === true;
  const accounts = (
    await client.query<AccountingAccount>(
      `SELECT qb_list_id AS id,full_name AS name,account_type,currency
    FROM qb_account WHERE qb_list_id=ANY($1::text[]) AND is_active AND deleted_at IS NULL ORDER BY qb_list_id FOR SHARE`,
      [
        [row.category_list_id, row.qb_list_id].filter(
          (value): value is string => Boolean(value)
        ),
      ]
    )
  ).rows.map((account) => receiptMapping(account, attested));
  const category = accounts.find((a) => a.id === row.category_list_id) ?? null;
  const bank = accounts.find((a) => a.id === row.qb_list_id) ?? null;
  const blockers: string[] = [];
  if ((await client.query(OPENING_TRANSACTION_CLAIM_SQL, [id])).rowCount)
    blockers.push("BANKING_OPENING_TRANSACTION_CLAIMED");
  let amount: number | null = null;
  try {
    amount = bankExpenseCents(row.amount);
  } catch {
    blockers.push("BANKING_EXPENSE_AMOUNT_INVALID");
  }
  if (row.deleted || row.status !== "posted")
    blockers.push("BANKING_POSTED_TRANSACTION_REQUIRED");
  if (row.account_type !== "depository")
    blockers.push("BANKING_EXPENSE_DEPOSITORY_REQUIRED");
  if (row.currency !== "USD" || row.account_currency !== "USD")
    blockers.push("BANKING_EXPENSE_USD_REQUIRED");
  if (!row.is_active || !row.is_selected)
    blockers.push("BANKING_EXPENSE_ACCOUNT_INACTIVE");
  if (
    !row.review_start_date ||
    !row.opening_reference ||
    row.opening_bank_balance === null ||
    row.transaction_date < row.review_start_date
  )
    blockers.push("BANKING_ACCOUNT_SETUP_REQUIRED");
  if (
    !reviewDate.safeParse(row.transaction_date).success ||
    row.transaction_date > reviewToday()
  )
    blockers.push("BANKING_EXPENSE_DATE_INVALID");
  if (row.review_status !== "confirmed" || row.mode !== "categorize")
    blockers.push("BANKING_EXPENSE_CONFIRMED_CATEGORY_REQUIRED");
  if (row.review_source_version !== row.source_version)
    blockers.push("BANKING_REVIEW_STALE");
  if (!category || !["Expense", "OtherExpense"].includes(category.account_type))
    blockers.push("BANKING_EXPENSE_CATEGORY_INVALID");
  if (category?.currency !== "USD")
    blockers.push("BANKING_EXPENSE_CATEGORY_CURRENCY_INVALID");
  if (!bank || bank.account_type !== "Bank" || bank.currency !== "USD")
    blockers.push("BANKING_EXPENSE_BANK_MAPPING_INVALID");
  if (
    !row.day_closed &&
    row.rule_id &&
    (row.rule_version !== row.current_rule_version || !row.current_rule_active)
  )
    blockers.push("BANKING_EXPENSE_RULE_STALE");
  if (row.day_closed && row.closed_review_revision !== row.review_revision)
    blockers.push("BANKING_EXPENSE_CLOSED_EVIDENCE_STALE");
  const source: AccountingSource = {
    id: row.id,
    account_id: row.account_id,
    account_name: row.account_name,
    day: row.transaction_date,
    name: row.name,
    amount_cents: amount,
    currency: row.currency,
    category,
    bank_account: bank,
    review_status: row.review_status ?? "pending",
    source_version: row.source_version,
    review_revision: row.review_revision,
  };
  // Availability and later rule edits are not historical accounting facts. A closed review
  // carries its approved rule revision; source/status/mapping/review edits remain detectable.
  const snapshot = {
    source,
    evidence: {
      status: row.status,
      deleted: row.deleted,
      mode: row.mode,
      amount: row.amount,
      review_source_version: row.review_source_version,
      category_snapshot: row.category_snapshot,
      counterparty_type: row.counterparty_type,
      counterparty_id: row.counterparty_id,
      rule_id: row.rule_id,
      rule_version: row.rule_version,
      comment: row.comment,
    },
  };
  return {
    source,
    source_hash: reviewHash(snapshot),
    snapshot,
    blockers,
    counterparty_id: row.counterparty_id,
    counterparty_type: row.counterparty_type,
  };
}
