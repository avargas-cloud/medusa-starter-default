import type { PoolClient } from "pg";
import { getDbPool } from "../../api/utils/db-pool";
import { transaction } from "./store";
import { BankingError, requireBankingSandbox } from "./security";
import { withReviewLock } from "./review-common";
import { accountingSource } from "./accounting-source";
import { expenseCandidates } from "./accounting-candidates";
import type { DuplicateCandidate, ExpenseDraft, JournalEntry } from "./accounting-types";

export async function accountingContext(client: PoolClient, id: string) {
  const context = await accountingSource(client, id);
  const draft = (await client.query<ExpenseDraft>(`SELECT id,transaction_id,revision,nature,reference,description,
    attested,dismissals,source_hash FROM bank_direct_expense WHERE transaction_id=$1 AND deleted_at IS NULL`, [id])).rows[0] ?? null;
  let candidates: DuplicateCandidate[] = [];
  try { candidates = await expenseCandidates(client, context, draft?.reference); }
  catch (error) {
    // The source remains visibly blocked, but its immutable history and explicit
    // reversal must remain accessible when candidate coverage exceeds the cap.
    if (!(error instanceof BankingError) || error.code !== "BANKING_EXPENSE_TOO_MANY_CANDIDATES") throw error;
    context.blockers.push(error.code);
  }
  const history = (await client.query<JournalEntry>(`SELECT e.id,e.day,e.kind,e.reference,e.description,
    e.amount_cents::float8 AS amount_cents,e.source_hash,e.reverses_entry_id,e.reason,e.created_at,
    (SELECT r.id FROM bank_journal_entry r WHERE r.reverses_entry_id=e.id) AS reversed_by,
    (e.source_hash<>$2) AS stale,
    (SELECT jsonb_agg(jsonb_build_object('role',l.role,'account_list_id',l.account_list_id,
      'account_name',l.account_snapshot->>'name','account_type',l.account_snapshot->>'account_type',
      'account_snapshot',l.account_snapshot,'debit_cents',l.debit_cents,'credit_cents',l.credit_cents)
      ORDER BY l.role) FROM bank_journal_line l WHERE l.entry_id=e.id) AS lines
    FROM bank_journal_entry e WHERE e.transaction_id=$1 ORDER BY e.created_at,e.id`, [id, context.source_hash])).rows;
  if (context.blockers.includes("BANKING_EXPENSE_RULE_STALE") || context.blockers.includes("BANKING_EXPENSE_CLOSED_EVIDENCE_STALE")) {
    for (const entry of history) entry.stale = true;
  }
  const posting = history.filter(e => e.kind === "expense").at(-1) ?? null;
  return { source: context.source, source_hash: context.source_hash, eligible: context.blockers.length === 0,
    blockers: context.blockers, draft, candidates, posting, history };
}

export async function readAccountingTransaction(id: string) {
  requireBankingSandbox();
  const client = await getDbPool().connect();
  try { return await transaction(client, async () => {
    await withReviewLock(client);
    return accountingContext(client, id);
  }); } finally { client.release(); }
}

export type AccountingFilters = { account_id?: string; from?: string; to?: string; offset: number; limit: number };
export async function listAccountingTransactions(filters: AccountingFilters) {
  requireBankingSandbox();
  const client = await getDbPool().connect();
  try { return await transaction(client, async () => {
    await withReviewLock(client);
    type ListRow = { id: string; amount: string; draft_hash: string | null; posting_hash: string | null; reversed: boolean };
    const result = (await client.query<{ count: number; page: ListRow[] }>(`WITH matching AS MATERIALIZED (
      SELECT t.id,t.amount,t.transaction_date FROM bank_transaction t
        JOIN bank_account a ON a.id=t.account_id JOIN bank_connection c ON c.id=a.connection_id
      WHERE ($1::text IS NULL OR a.id=$1) AND t.deleted_at IS NULL AND a.deleted_at IS NULL AND c.deleted_at IS NULL
        AND c.environment='sandbox' AND ($2::text IS NULL OR t.transaction_date >= $2)
        AND ($3::text IS NULL OR t.transaction_date <= $3)
    ), paged AS (SELECT * FROM matching ORDER BY transaction_date DESC,id DESC LIMIT $4 OFFSET $5),
    projected AS (SELECT p.*,d.source_hash AS draft_hash,e.source_hash AS posting_hash,
      EXISTS(SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id=e.id) AS reversed
      FROM paged p LEFT JOIN bank_direct_expense d ON d.transaction_id=p.id AND d.deleted_at IS NULL
      LEFT JOIN LATERAL(SELECT id,source_hash FROM bank_journal_entry j WHERE j.transaction_id=p.id AND j.kind='expense'
        ORDER BY j.created_at DESC,j.id DESC LIMIT 1) e ON true)
    SELECT (SELECT COUNT(*)::integer FROM matching) AS count,
      COALESCE((SELECT jsonb_agg(projected ORDER BY transaction_date DESC,id DESC) FROM projected),'[]') AS page`,
    [filters.account_id ?? null, filters.from ?? null, filters.to ?? null, filters.limit, filters.offset])).rows[0]!;
    const rows = [];
    for (const row of result.page) {
      // Read only the source/account evidence for this bounded page. Duplicate scans and
      // journal history belong to the detail; an ambiguous source cannot hide the list.
      const detail = await accountingSource(client, row.id);
      const { source } = detail;
      rows.push({ id: source.id, account_id: source.account_id, account_name: source.account_name,
        day: source.day, name: source.name, amount_cents: signedBankCents(row.amount), currency: source.currency,
        review_status: source.review_status, accounting_status: row.posting_hash ? row.reversed ? "reversed" : "posted"
          : detail.blockers.length ? "unsupported" : row.draft_hash ? "draft" : "pending",
        stale: Boolean((row.posting_hash ?? row.draft_hash) && ((row.posting_hash ?? row.draft_hash) !== detail.source_hash
          || detail.blockers.includes("BANKING_EXPENSE_RULE_STALE") || detail.blockers.includes("BANKING_EXPENSE_CLOSED_EVIDENCE_STALE"))) });
    }
    return { transactions: rows, count: result.count };
  }); } finally { client.release(); }
}

function signedBankCents(amount: string): number | null {
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(amount)) return null;
  const [whole, fraction = ""] = amount.replace(/^-/, "").split(".");
  const value = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(value) * (amount.startsWith("-") ? 1 : -1);
}
