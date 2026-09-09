import type { PoolClient } from "pg";
import { receiptRead } from "./receipts-setup";
import { BankingError } from "./security";
import { bankAccountingCurrency, bankExpenseCents, type AccountingAccount } from "./accounting-types";
import { reviewHash } from "./review-common";
import { completionEvidence } from "./completion-evidence";
import { reviewDate } from "./review-date";
import { payrollHalves } from "../../api/admin/reports/_lib/monthly-payroll";
import { getBusinessDateString } from "../date/et";
import { assertMovementNewExpense } from "./movement-existing-expense";
import type { CompletionClaim, MovementAllocation, MovementSourceKind } from "./movement-types";

export const normalizeDocumentReference = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");
/** A payroll installment is one economic identity; the monthly total is never a second claim namespace. */
export function payrollInstallment(month: string, amountCents: number, sourceId: string) {
  if (!/^\d{4}-(?:0[1-9]|1[0-2]):(?:15|28|29|30)$/.test(sourceId))
    throw new BankingError("BANKING_MOVEMENT_SOURCE_UNRESOLVED", 409);
  const installment = payrollHalves(month, amountCents).map(half => ({
    id: `${month}:${getBusinessDateString(half.at).slice(8)}`, day: getBusinessDateString(half.at), amount_cents: half.cents,
  })).find(half => half.id === sourceId && half.amount_cents > 0);
  if (!installment) throw new BankingError("BANKING_MOVEMENT_SOURCE_UNRESOLVED", 409);
  return installment;
}
export async function movementAccounts(client: PoolClient, ids?: string[], attested = false): Promise<AccountingAccount[]> {
  const accounts = (await client.query<AccountingAccount>(`SELECT qb_list_id AS id,full_name AS name,account_type,currency FROM qb_account
    WHERE deleted_at IS NULL AND is_active AND ($1::text[] IS NULL OR qb_list_id=ANY($1::text[]))
    AND account_type IN ('Bank','AccountsPayable','AccountsReceivable','OtherCurrentAsset','OtherAsset','CreditCard',
      'LongTermLiability','OtherCurrentLiability','Equity','Expense','OtherExpense') ORDER BY full_name,qb_list_id FOR SHARE`, [ids ?? null])).rows;
  return accounts.map(a => ({ ...a, qb_currency_ref: a.currency,
    currency: bankAccountingCurrency(a.account_type, a.currency) ?? (attested && a.currency === null && a.account_type !== "Bank" ? "USD" : null) }));
}
export const listMovementAccounts = () => receiptRead(async client => ({ accounts: await movementAccounts(client) }));
export async function movementBank(client: PoolClient, id: string, day: string) {
  const bank = (await client.query<{ id: string; qb_list_id: string; review_start_date: string | null }>(`SELECT a.id,a.qb_list_id,a.review_start_date
    FROM bank_account a JOIN bank_connection c ON c.id=a.connection_id WHERE a.id=$1 AND a.is_active AND a.is_selected
    AND a.currency='USD' AND a.type='depository' AND a.deleted_at IS NULL AND c.deleted_at IS NULL AND c.environment='sandbox' FOR SHARE OF a,c`, [id])).rows[0];
  const account = bank?.qb_list_id ? (await movementAccounts(client, [bank.qb_list_id]))[0] : undefined;
  if (!bank || !account || account.account_type !== "Bank" || account.currency !== "USD") throw new BankingError("BANKING_MOVEMENT_BANK_INVALID", 409);
  if (!bank.review_start_date || day < bank.review_start_date) throw new BankingError("BANKING_MOVEMENT_BEFORE_CUT", 409);
  return account;
}
export async function movementTransaction(client: PoolClient, id: string, bank: AccountingAccount, day: string, signedCents: number): Promise<CompletionClaim> {
  const tx = (await client.query<{ id: string; account_list_id: string; transaction_date: string; amount: string; currency: string;
    status: string; source_version: number }>(`SELECT t.id,a.qb_list_id AS account_list_id,t.transaction_date,t.amount,t.currency,t.status,t.source_version
    FROM bank_transaction t JOIN bank_account a ON a.id=t.account_id WHERE t.id=$1 AND t.deleted_at IS NULL FOR SHARE OF t,a`, [id])).rows[0];
  if (!tx || tx.status !== "posted" || tx.currency !== "USD" || tx.account_list_id !== bank.id || tx.transaction_date !== day)
    throw new BankingError("BANKING_MOVEMENT_TRANSACTION_INVALID", 409);
  const actual = (tx.amount.startsWith("-") ? -1 : 1) * bankExpenseCents(tx.amount.replace(/^-/, ""));
  if (actual !== signedCents) throw new BankingError("BANKING_TRANSACTION_AMOUNT_INVALID", 409);
  return { source_kind: "transaction", source_id: tx.id, amount_cents: Math.abs(actual), capacity_cents: Math.abs(actual),
    source_hash: reviewHash(tx), source_snapshot: tx };
}
export async function movementSourceIdentity(client: PoolClient, kind: MovementSourceKind, id: string): Promise<Record<string, unknown>> {
  let row: Record<string, unknown> | undefined;
  if (kind === "vendor_bill") {
    row = (await client.query(`SELECT id,number,reference_id,vendor_id,status,document_date,
      (document_date AT TIME ZONE 'America/New_York')::date::text AS economic_day,qb_txn_id,qb_is_paid,
      qb_edit_sequence,deleted_at IS NOT NULL AS deleted FROM vendor_bill WHERE id=$1 FOR SHARE`, [id])).rows[0];
    if (row && !row.deleted && ["confirmed", "synced"].includes(String(row.status))) {
      row.lines = (await client.query(`SELECT id,line_type,line_kind,qty,unit_cost_cents,amount_cents,qb_account_list_id
        FROM vendor_bill_line WHERE vendor_bill_id=$1 AND deleted_at IS NULL ORDER BY id FOR SHARE`, [id])).rows;
    } else row = undefined;
  } else if (kind === "wire") {
    row = (await client.query("SELECT * FROM china_wire_transfer WHERE id=$1 AND status='confirmed' FOR SHARE", [id])).rows[0];
    if (row) {
      row.applications = (await client.query("SELECT * FROM china_wire_transfer_application WHERE wire_transfer_id=$1 ORDER BY id FOR SHARE", [id])).rows;
      row.credits = (await client.query("SELECT * FROM china_finance_wire_credit WHERE wire_transfer_id=$1 ORDER BY id FOR SHARE", [id])).rows;
    }
  } else if (kind === "payroll") {
    const month = id.split(":")[0]!;
    row = (await client.query("SELECT month,amount_cents,note,updated_at FROM pos_monthly_payroll WHERE month=$1 FOR SHARE", [month])).rows[0];
    if (row) {
      const installment = payrollInstallment(month, Number(row.amount_cents), id);
      row = { ...row, month_amount_cents: row.amount_cents, amount_cents: installment.amount_cents,
        economic_day: installment.day, reference: `Payroll ${installment.day}`, installment_id: installment.id };
    }
  } else if (kind === "refund") {
    row = (await client.query(`SELECT id,type,status,method,amount::text,currency,customer_id,metadata,batch_day,medusa_refund_id
      FROM customer_payment WHERE id=$1 AND deleted_at IS NULL AND lower(currency)='usd' AND status<>'voided'
      AND (type='refund' OR (status IN ('refunded','partial_refunded') AND metadata->>'refund_amount' IS NOT NULL)) FOR SHARE`, [id])).rows[0];
  } else return { reference: normalizeDocumentReference(id) };
  if (!row) throw new BankingError("BANKING_MOVEMENT_SOURCE_UNRESOLVED", 409);
  return row;
}
export function assertMovementSourceDate(kind: MovementSourceKind, identity: Record<string, unknown>, asOf: string | null,
  capacity: number | null) {
  if (kind === "document" || asOf === null) return;
  const rawDay = kind === "vendor_bill" ? identity.economic_day : kind === "wire" ? identity.sent_date
    : kind === "refund" ? (identity.metadata as Record<string, unknown> | null)?.refund_txn_date ?? identity.batch_day
    : identity.economic_day;
  const day = rawDay instanceof Date ? rawDay.toISOString().slice(0, 10) : rawDay;
  if (!reviewDate.safeParse(day).success || String(day) > asOf)
    throw new BankingError("BANKING_MOVEMENT_SOURCE_DATE_INVALID", 409);
  if (kind === "payroll" && capacity !== null && capacity > Number(identity.amount_cents))
    throw new BankingError("BANKING_DOCUMENTED_CAPACITY_INVALID", 409);
}
export async function movementAllocationFact(client: PoolClient, line: MovementAllocation) {
  if (line.recognition_owner === "new" && line.source_kind === "document") await assertMovementNewExpense(client, line.source_id);
  const evidence = await completionEvidence(client, line.evidence_id);
  const identity = await movementSourceIdentity(client, line.source_kind, line.source_id);
  assertMovementSourceDate(line.source_kind, identity, line.documented_as_of, line.documented_capacity_cents);
  const knownAmount = line.source_kind === "wire" ? Number(identity.wire_amount_cents)
    : line.source_kind === "payroll" ? Number(identity.amount_cents)
    : line.source_kind === "refund" ? Number(identity.type === "refund" ? identity.amount
      : (identity.metadata as Record<string, unknown> | null)?.refund_amount) : null;
  if (knownAmount !== null && (!Number.isSafeInteger(knownAmount) || knownAmount <= 0
    || line.amount_cents > knownAmount || (line.documented_capacity_cents !== null && line.documented_capacity_cents > knownAmount)))
    throw new BankingError("BANKING_DOCUMENTED_CAPACITY_INVALID", 409);
  // Recognition ownership is explicit. Never infer remaining AP from qb_balance_remaining_cents.
  const snapshot = { identity, evidence: { sha256: evidence.sha256, version: evidence.version },
    documented_capacity_cents: line.documented_capacity_cents, documented_as_of: line.documented_as_of,
    recognition_owner: line.recognition_owner, account_list_id: line.account_list_id, role: line.role };
  const claims: CompletionClaim[] = [];
  if (line.documented_capacity_cents !== null && line.documented_as_of !== null) {
    claims.push({ source_kind: line.source_kind, source_id: line.source_kind === "document" ? normalizeDocumentReference(line.source_id) : line.source_id,
      amount_cents: line.amount_cents, capacity_cents: line.documented_capacity_cents, source_hash: reviewHash(snapshot), source_snapshot: snapshot });
    if (line.source_kind === "document") {
      const monetaryEvidence = { sha256: evidence.sha256, account_list_id: line.account_list_id, role: line.role,
        documented_capacity_cents: line.documented_capacity_cents, documented_as_of: line.documented_as_of };
      claims.push({ source_kind: "document_evidence", source_id: `${evidence.sha256}:${line.account_list_id}:${line.role}`,
        amount_cents: line.amount_cents, capacity_cents: line.documented_capacity_cents,
        source_hash: reviewHash(monetaryEvidence), source_snapshot: monetaryEvidence });
    }
  }
  return { snapshot, claims };
}
export const listMovementSources = (kind: MovementSourceKind, q: string) => receiptRead(async client => {
  const search = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
  let rows: Array<Record<string, unknown>> = [];
  if (kind === "vendor_bill") rows = (await client.query(`SELECT id,COALESCE(number,reference_id,id) AS reference,
    (document_date AT TIME ZONE 'America/New_York')::date::text AS day,NULL::bigint AS amount_cents FROM vendor_bill
    WHERE deleted_at IS NULL AND status IN ('confirmed','synced') AND (id ILIKE $1 OR number ILIKE $1 OR reference_id ILIKE $1)
    ORDER BY document_date DESC NULLS LAST,id LIMIT 101`, [search])).rows;
  else if (kind === "wire") rows = (await client.query(`SELECT id,id AS reference,sent_date::text AS day,wire_amount_cents::bigint AS amount_cents
    FROM china_wire_transfer WHERE status='confirmed' AND id ILIKE $1 ORDER BY sent_date DESC NULLS LAST,id LIMIT 101`, [search])).rows;
  else if (kind === "payroll") rows = (await client.query(`WITH installments AS (
    SELECT month||':'||half.day_no::text AS id,'Payroll '||month||'-'||half.day_no::text AS reference,
      month||'-'||half.day_no::text AS day,
      CASE WHEN half.sequence=1 THEN floor(amount_cents::numeric/2) ELSE amount_cents-floor(amount_cents::numeric/2) END AS amount_cents
    FROM pos_monthly_payroll CROSS JOIN LATERAL (VALUES (1,15),(2,LEAST(30,
      extract(day FROM (month||'-01')::date+interval '1 month'-interval '1 day')::integer))) half(sequence,day_no)
    ) SELECT * FROM installments WHERE amount_cents>0 AND (id ILIKE $1 OR reference ILIKE $1)
    ORDER BY day DESC,id LIMIT 101`, [search])).rows;
  else if (kind === "refund") rows = (await client.query(`SELECT id,COALESCE(reference,id) AS reference,
    COALESCE(metadata->>'refund_txn_date',batch_day) AS day,
    CASE WHEN type='refund' THEN amount::numeric ELSE (metadata->>'refund_amount')::numeric END AS amount_cents
    FROM customer_payment WHERE deleted_at IS NULL AND status<>'voided' AND lower(currency)='usd'
    AND (type='refund' OR (status IN ('refunded','partial_refunded') AND metadata->>'refund_amount' ~ '^[0-9]+$'))
    AND (id ILIKE $1 OR reference ILIKE $1) ORDER BY received_at DESC,id LIMIT 101`, [search])).rows;
  return { sources: rows.slice(0, 100).map(r => ({ ...r, kind, amount_cents: r.amount_cents == null ? null : Number(r.amount_cents),
    documented_capacity_cents: null })), more: rows.length > 100 };
});
