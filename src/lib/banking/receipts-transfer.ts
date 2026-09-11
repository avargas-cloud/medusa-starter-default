import type { PoolClient } from "pg";

import {
  bankAccountingCurrency,
  type AccountingAccount,
} from "./accounting-types";
import { loadBankDeposit } from "./deposit-read";
import { depositCents, depositSourceKey } from "./deposit-types";
import { paymentReservedCentsSql } from "./payment-evidence";
import {
  receiptAccounts,
  receiptMapping,
  receiptSetup,
} from "./receipts-setup";
import {
  paymentReceiptSource,
  receiptLine,
  type ReceiptEvidence,
} from "./receipts-source";
import type { ReceiptSource } from "./receipts-types";
import { reviewHash } from "./review-common";
import { reviewDate, reviewToday } from "./review-date";
import {
  validateMatchedPayment,
  assertMatchSourceHash,
} from "./review-matching";
import { BankingError, bankingEnvSql } from "./security";

async function bankMapping(
  client: PoolClient,
  id: string,
  blockers: string[]
): Promise<AccountingAccount | null> {
  const account = (
    await client.query<{ qb_list_id: string; valid: boolean }>(
      `SELECT a.qb_list_id,
    (a.deleted_at IS NULL AND c.deleted_at IS NULL AND a.is_active AND a.is_selected
      AND a.type='depository' AND a.currency='USD') AS valid
    FROM bank_account a JOIN bank_connection c ON c.id=a.connection_id
    WHERE a.id=$1 AND c.environment=${bankingEnvSql()} FOR SHARE OF a,c`,
      [id]
    )
  ).rows[0];
  const live = account?.qb_list_id
    ? (await receiptAccounts(client, [account.qb_list_id]))[0]
    : undefined;
  const bank = live
    ? receiptMapping(live, (await receiptSetup(client))?.attested === true)
    : undefined;
  if (
    !account?.valid ||
    !bank ||
    bank.account_type !== "Bank" ||
    bank.currency !== "USD"
  ) {
    blockers.push("BANKING_RECEIPT_BANK_MAPPING_INVALID");
    return null;
  }
  return bank;
}
async function allocate(
  client: PoolClient,
  evidence: ReceiptEvidence,
  paymentId: string,
  cents: number
): Promise<{
  id: string;
  hash: string;
  posting_hash: string | null;
  cents: number;
}> {
  const payment = await paymentReceiptSource(client, paymentId);
  evidence.blockers.push(...payment.blockers);
  if (payment.source.day > evidence.source.day)
    evidence.blockers.push("BANKING_RECEIPT_TRANSFER_DATE_INVALID");
  const row = (
    await client.query<{
      receipt_id: string;
      source_hash: string;
      amount_cents: string;
    }>(
      `SELECT a.id AS receipt_id,
    e.source_hash,e.amount_cents FROM bank_receipt_accounting a JOIN bank_journal_entry e ON e.receipt_id=a.id
    WHERE a.payment_id=$1 AND e.kind='receipt' AND NOT EXISTS(SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id=e.id)`,
      [paymentId]
    )
  ).rows[0];
  if (!row) evidence.blockers.push("BANKING_RECEIPT_POSTING_REQUIRED");
  else {
    if (row.source_hash !== payment.source_hash)
      evidence.blockers.push("BANKING_RECEIPT_SOURCE_DRIFT");
    const reserved = (
      await client.query<{ cents: string }>(
        `SELECT ${paymentReservedCentsSql({ deposit: "$2::text", transaction: "$3::text" })} AS cents
      FROM customer_payment mp WHERE mp.id=$1`,
        [
          paymentId,
          evidence.source.kind === "deposit" ? evidence.source.id : null,
          evidence.source.kind === "payment_match" ? evidence.source.id : null,
        ]
      )
    ).rows[0];
    if (
      !reserved ||
      !/^\d+(?:\.0+)?$/.test(reserved.cents) ||
      BigInt(row.amount_cents) -
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- the regex test above already guarantees reserved.cents matches \d+ so split('.') has a first element
        BigInt(reserved.cents.split(".")[0]!) <
        BigInt(cents)
    )
      evidence.blockers.push("BANKING_RECEIPT_OVER_RESERVED");
    evidence.allocations.push({
      payment_id: paymentId,
      receipt_id: row.receipt_id,
      amount_cents: cents,
    });
  }
  return {
    id: paymentId,
    hash: payment.source_hash,
    posting_hash: row?.source_hash ?? null,
    cents,
  };
}
async function feeAccount(
  client: PoolClient,
  id: string | null,
  reference: string | null,
  blockers: string[]
): Promise<AccountingAccount | null> {
  const account = id ? (await receiptAccounts(client, [id]))[0] : null;
  if (
    !account ||
    !["Expense", "OtherExpense"].includes(account.account_type) ||
    bankAccountingCurrency(account.account_type, account.currency) !== "USD" ||
    !reference?.trim()
  ) {
    blockers.push("BANKING_RECEIPT_FEE_INVALID");
    return null;
  }
  // Explicit existing source identities cannot be reclassified as a new bank fee.
  const duplicate = await client.query(
    `SELECT id FROM bank_journal_entry WHERE kind<>'reversal'
      AND ($1=id OR $1='journal:'||id OR $1=expense_id OR $1='expense:'||expense_id)
    UNION ALL SELECT id FROM vendor_bill WHERE deleted_at IS NULL AND ($1=id OR $1='vendor_bill:'||id)
    UNION ALL SELECT id FROM china_wire_transfer WHERE $1=id OR $1='wire:'||id
    UNION ALL SELECT month FROM pos_monthly_payroll WHERE $1='payroll:'||month
    UNION ALL SELECT id FROM bank_direct_expense WHERE deleted_at IS NULL AND ($1=id OR $1='expense:'||id) LIMIT 1`,
    [reference]
  );
  if (duplicate.rowCount)
    blockers.push("BANKING_RECEIPT_FEE_ALREADY_RECOGNIZED");
  return { ...account, qb_currency_ref: account.currency, currency: "USD" };
}
/**
 * banking-on-gl: a manual Undeposited-Funds line has no payment to look up —
 * it's a pre-cutover receipt the GL never individually recognized (it only
 * replays `customer_payment` on/after the cutover). The deposit's own
 * bank/clearing lines (Dr Bank / Cr Undeposited Funds) already cover it; this
 * just records the allocation for the audit trail, with no source claim.
 */
function allocateManual(
  evidence: ReceiptEvidence,
  reference: string,
  description: string,
  amount: string,
  cents: number,
  expectedHash: string
): { manual_reference: string; hash: string; cents: number } {
  const hash = reviewHash({ manual: true, reference, description, amount });
  if (hash !== expectedHash)
    evidence.blockers.push("BANKING_RECEIPT_SOURCE_DRIFT");
  evidence.allocations.push({
    payment_id: null,
    receipt_id: null,
    manual_reference: reference,
    manual_description: description || null,
    amount_cents: cents,
  });
  return { manual_reference: reference, hash, cents };
}
export async function depositReceiptSource(
  client: PoolClient,
  id: string
): Promise<ReceiptEvidence> {
  const deposit = await loadBankDeposit(client, id),
    setup = await receiptSetup(client),
    blockers: string[] = [];
  await client.query("SELECT id FROM bank_deposit WHERE id=$1 FOR SHARE", [id]);
  const gross = Number(depositCents(deposit.gross_amount)),
    net = Number(depositCents(deposit.net_amount)),
    fee = Number(depositCents(deposit.fee_amount));
  const source: ReceiptSource = {
    id,
    kind: "deposit",
    day: deposit.date,
    name: deposit.reference,
    reference: deposit.reference,
    amount_cents: gross,
    net_cents: net,
    fee_cents: fee,
    currency: deposit.currency,
    fee_reference: deposit.fee_reference,
    payment_ids: deposit.lines.flatMap((l) =>
      l.payment_id ? [l.payment_id] : []
    ),
    account_id: deposit.account_id,
  };
  if (!setup) blockers.push("BANKING_RECEIPT_SETUP_REQUIRED");
  if (deposit.status !== "ready" || deposit.stale)
    blockers.push("BANKING_RECEIPT_READY_DEPOSIT_REQUIRED");
  if (deposit.currency !== "USD") blockers.push("BANKING_RECEIPT_USD_REQUIRED");
  if (
    !reviewDate.safeParse(deposit.date).success ||
    deposit.date > reviewToday() ||
    (setup && deposit.date < setup.cut_date)
  )
    blockers.push("BANKING_RECEIPT_DATE_INVALID");
  if (
    gross > 999999999999 ||
    gross !== net + fee ||
    net <= 0 ||
    fee < 0 ||
    !deposit.lines.length ||
    deposit.lines.length > 100 ||
    new Set(deposit.lines.map(depositSourceKey)).size !== deposit.lines.length
  )
    blockers.push("BANKING_RECEIPT_AMOUNT_INVALID");
  const bank = await bankMapping(client, deposit.account_id, blockers);
  const expense = fee
    ? await feeAccount(
        client,
        deposit.fee_account_list_id,
        deposit.fee_reference,
        blockers
      )
    : null;
  const evidence: ReceiptEvidence = {
    source,
    source_hash: "",
    snapshot: {},
    setup,
    blockers,
    lines: [],
    allocations: [],
  };
  const payments = [];
  for (const line of [...deposit.lines].sort((a, b) =>
    depositSourceKey(a).localeCompare(depositSourceKey(b))
  )) {
    const cents = Number(depositCents(line.amount));
    if (cents <= 0) blockers.push("BANKING_RECEIPT_AMOUNT_INVALID");
    payments.push(
      line.manual
        ? allocateManual(
            evidence,
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- depositSourceKey (called on every line during the sort above) throws unless line.reference is set when line.manual is true
            line.reference!,
            line.description ?? "",
            line.amount,
            cents,
            line.source_hash
          )
        : // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- depositSourceKey (called on every line during the sort above) throws unless exactly one of payment_id/manual is set; payment_id is set here
          await allocate(client, evidence, line.payment_id!, cents)
    );
  }
  if (payments.reduce((sum, payment) => sum + payment.cents, 0) !== gross)
    blockers.push("BANKING_RECEIPT_AMOUNT_INVALID");
  if (bank && setup)
    evidence.lines.push(
      receiptLine("bank", bank, net, true),
      receiptLine("clearing", setup.clearing_account, gross, false)
    );
  if (expense) evidence.lines.push(receiptLine("expense", expense, fee, true));
  evidence.snapshot = {
    source,
    deposit: { ...deposit, accounting_posted: undefined },
    payments,
    bank,
    expense,
    setup: setup ? { ...setup, frozen: undefined } : null,
  };
  evidence.source_hash = reviewHash(evidence.snapshot);
  return evidence;
}
type MatchRow = {
  id: string;
  day: string;
  account_id: string;
  name: string;
  currency: string;
  amount: string;
  source_version: number;
  review_source_version: number;
  revision: number;
  status: string;
  review_status: string;
  matched_payment_id: string | null;
  match_snapshot: { source_hash?: string } | null;
  deleted: boolean;
  mode: string;
  day_closed: boolean;
  closed_revision: number | null;
  rule_id: string | null;
  rule_version: number | null;
  current_rule_version: number | null;
  current_rule_active: boolean | null;
};
export async function matchReceiptSource(
  client: PoolClient,
  id: string
): Promise<ReceiptEvidence> {
  const row = (
    await client.query<MatchRow>(
      `SELECT t.id,t.transaction_date AS day,t.account_id,t.name,t.currency,t.amount,t.status,
    t.source_version,r.source_version AS review_source_version,r.revision,r.status AS review_status,r.mode,
    r.matched_payment_id,r.match_snapshot,(t.deleted_at IS NOT NULL OR r.deleted_at IS NOT NULL) AS deleted,
    COALESCE(dc.status='closed',false) AS day_closed,r.rule_id,r.rule_version,rr.version AS current_rule_version,rr.active AS current_rule_active,
    (SELECT (st->'review'->>'revision')::integer FROM jsonb_array_elements(COALESCE(dc.snapshot->'accounts','[]')) sa,
      jsonb_array_elements(COALESCE(sa->'transactions','[]')) st WHERE st->>'id'=t.id LIMIT 1) AS closed_revision
    FROM bank_transaction t LEFT JOIN bank_transaction_review r ON r.transaction_id=t.id
    LEFT JOIN bank_review_rule rr ON rr.id=r.rule_id AND rr.deleted_at IS NULL
    LEFT JOIN bank_day_close dc ON dc.day=t.transaction_date AND dc.deleted_at IS NULL
    WHERE t.id=$1 FOR SHARE OF t`,
      [id]
    )
  ).rows[0];
  if (!row) throw new BankingError("BANKING_TRANSACTION_NOT_FOUND", 404);
  const blockers: string[] = [],
    setup = await receiptSetup(client);
  let cents: number | null = null;
  try {
    if (!row.amount.startsWith("-")) throw new Error();
    cents = Number(depositCents(row.amount.slice(1)));
  } catch {
    blockers.push("BANKING_RECEIPT_AMOUNT_INVALID");
  }
  const source: ReceiptSource = {
    id,
    kind: "payment_match",
    day: row.day,
    name: row.name,
    reference: row.name,
    amount_cents: cents,
    net_cents: cents,
    fee_cents: 0,
    currency: row.currency,
    payment_ids: row.matched_payment_id ? [row.matched_payment_id] : [],
    account_id: row.account_id,
  };
  if (!setup) blockers.push("BANKING_RECEIPT_SETUP_REQUIRED");
  if (!cents || cents > 999999999999)
    blockers.push("BANKING_RECEIPT_AMOUNT_INVALID");
  if (
    row.deleted ||
    row.status !== "posted" ||
    row.review_status !== "confirmed" ||
    row.mode !== "match" ||
    !row.matched_payment_id ||
    row.source_version !== row.review_source_version
  )
    blockers.push("BANKING_RECEIPT_CONFIRMED_MATCH_REQUIRED");
  if (row.day_closed && row.closed_revision !== row.revision)
    blockers.push("BANKING_RECEIPT_CLOSED_EVIDENCE_STALE");
  if (
    !row.day_closed &&
    row.rule_id &&
    (row.rule_version !== row.current_rule_version || !row.current_rule_active)
  )
    blockers.push("BANKING_RECEIPT_RULE_STALE");
  if (
    !reviewDate.safeParse(row.day).success ||
    row.day > reviewToday() ||
    (setup && row.day < setup.cut_date)
  )
    blockers.push("BANKING_RECEIPT_DATE_INVALID");
  const bank = await bankMapping(client, row.account_id, blockers);
  const evidence: ReceiptEvidence = {
    source,
    source_hash: "",
    snapshot: {},
    setup,
    blockers,
    lines: [],
    allocations: [],
  };
  let payment: unknown = null;
  if (row.matched_payment_id && cents) {
    try {
      const matched = await validateMatchedPayment(
        client,
        id,
        row.matched_payment_id
      );
      assertMatchSourceHash(
        row.match_snapshot?.source_hash,
        matched.source_hash,
        matched.legacy_source_hash
      );
    } catch (error) {
      if (error instanceof BankingError) blockers.push(error.code);
      else throw error;
    }
    payment = await allocate(client, evidence, row.matched_payment_id, cents);
  }
  if (bank && setup && cents)
    evidence.lines.push(
      receiptLine("bank", bank, cents, true),
      receiptLine("clearing", setup.clearing_account, cents, false)
    );
  evidence.snapshot = {
    source,
    match: {
      ...row,
      day_closed: undefined,
      closed_revision: undefined,
      current_rule_version: undefined,
      current_rule_active: undefined,
    },
    payment,
    bank,
    setup: setup ? { ...setup, frozen: undefined } : null,
  };
  evidence.source_hash = reviewHash(evidence.snapshot);
  return evidence;
}
