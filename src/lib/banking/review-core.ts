import { assertNoOpeningClear } from "./opening-guards";
import { assertDepositSourceHash, validateMatchedDeposit } from "./deposit-matching";
import type { PoolClient } from "pg";
import { bankId } from "./store";
import { BankingError, bankingEnvSql } from "./security";
import { appendReviewEvent, requireOpenReviewDay, reviewCapacity, runReviewCommand } from "./review-common";
import { validateCategory, validateCounterparty } from "./review-lookups";
import { assertMatchSourceHash, validateMatchedPayment } from "./review-matching";
import { REVIEW_COLUMNS, type Review, type ReviewTransaction, type ReviewVersions } from "./review-types";

export type ReviewContext = { tx: ReviewTransaction; review: Review | null };
export async function loadReviewContext(client: PoolClient, id: string, versions: ReviewVersions): Promise<ReviewContext> {
  const result = await client.query<ReviewTransaction>(`SELECT t.id,t.account_id,t.transaction_date,
    t.source_version,t.amount,t.currency,t.status,t.name,t.merchant_name,a.type AS account_type,
    a.review_start_date,a.opening_bank_balance,a.opening_reference FROM bank_transaction t
    JOIN bank_account a ON a.id=t.account_id JOIN bank_connection c ON c.id=a.connection_id
    WHERE t.id=$1 AND t.deleted_at IS NULL AND a.deleted_at IS NULL
      AND c.deleted_at IS NULL AND c.environment=${bankingEnvSql()} FOR UPDATE OF t`, [id]);
  const tx = result.rows[0];
  if (!tx) throw new BankingError("BANKING_TRANSACTION_NOT_FOUND", 404);
  const previous = await client.query<Review>(`SELECT ${REVIEW_COLUMNS}
    FROM bank_transaction_review WHERE transaction_id=$1 AND deleted_at IS NULL FOR UPDATE`, [id]);
  const review = previous.rows[0] ?? null;
  if ((review?.revision ?? 0) !== versions.expected_revision || tx.source_version !== versions.expected_source_version) {
    throw new BankingError("BANKING_REVIEW_VERSION_CONFLICT", 409);
  }
  await requireOpenReviewDay(client, tx.transaction_date);
  if (tx.review_start_date && tx.transaction_date < tx.review_start_date) {
    throw new BankingError("BANKING_TRANSACTION_BEFORE_REVIEW_START", 409);
  }
  return { tx, review };
}

/** Caller holds the global lock and loaded the source/review with CAS. */
export async function persistReview(client: PoolClient, context: ReviewContext, changes: Partial<Review>,
  actorId: string, action: string, details: Record<string, unknown> = {}): Promise<Review> {
  await assertNoOpeningClear(client, context.tx.id);
  const before = context.review;
  // A posted direct transfer owns its receipt even if somebody clears its feed evidence.
  // Grouped deposits are independent documents: matching/unmatching those stays evidence-only.
  const nextMode = changes.mode ?? before?.mode;
  const nextPayment = changes.matched_payment_id === undefined ? before?.matched_payment_id : changes.matched_payment_id;
  if (nextMode !== before?.mode || nextPayment !== before?.matched_payment_id || changes.status === "excluded") {
    const posted = await client.query(`SELECT entry.id FROM bank_journal_entry entry
      WHERE entry.transaction_id=$1 AND entry.kind='payment_match'
        AND NOT EXISTS(SELECT 1 FROM bank_journal_entry reversal WHERE reversal.reverses_entry_id=entry.id) LIMIT 1`, [context.tx.id]);
    if (posted.rowCount) throw new BankingError("BANKING_MATCH_ACCOUNTING_REVERSAL_REQUIRED", 409);
  }
  if (!before) await reviewCapacity(client, "bank_transaction_review", 2000);
  const next: Review = {
    id: before?.id ?? bankId("btr"), transaction_id: context.tx.id, revision: 0,
    source_version: context.tx.source_version, status: "draft", mode: "categorize",
    category_list_id: null, counterparty_type: null, counterparty_id: null, counterparty_name: null,
    matched_deposit_id: null, deposit_snapshot: null, comment: "", matched_payment_id: null, match_snapshot: null, category_snapshot: null,
    origin: "manual", rule_id: null, rule_version: null, manual_override: false,
    confirmed_by: null, confirmed_at: null, exclusion_reason: null,
    ...before, ...changes,
  };
  next.revision = (before?.revision ?? 0) + 1;
  next.source_version = changes.source_version ?? context.tx.source_version;
  const values = [next.id, next.transaction_id, next.revision, next.source_version, next.status, next.mode,
    next.category_list_id, next.counterparty_type, next.counterparty_id, next.counterparty_name, next.comment,
    next.matched_payment_id, JSON.stringify(next.match_snapshot), JSON.stringify(next.category_snapshot),
    next.origin, next.rule_id, next.rule_version, next.manual_override, next.confirmed_by,
    next.confirmed_at, next.exclusion_reason, next.matched_deposit_id, JSON.stringify(next.deposit_snapshot)];
  const result = await client.query<Review>(`INSERT INTO bank_transaction_review (${REVIEW_COLUMNS})
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15,$16,$17,$18,$19,$20,$21,$22,$23::jsonb)
    ON CONFLICT (transaction_id) DO UPDATE SET revision=EXCLUDED.revision,source_version=EXCLUDED.source_version,
    matched_deposit_id=EXCLUDED.matched_deposit_id,deposit_snapshot=EXCLUDED.deposit_snapshot,
    status=EXCLUDED.status,mode=EXCLUDED.mode,category_list_id=EXCLUDED.category_list_id,
    counterparty_type=EXCLUDED.counterparty_type,counterparty_id=EXCLUDED.counterparty_id,
    counterparty_name=EXCLUDED.counterparty_name,comment=EXCLUDED.comment,matched_payment_id=EXCLUDED.matched_payment_id,
    match_snapshot=EXCLUDED.match_snapshot,category_snapshot=EXCLUDED.category_snapshot,origin=EXCLUDED.origin,
    rule_id=EXCLUDED.rule_id,rule_version=EXCLUDED.rule_version,manual_override=EXCLUDED.manual_override,
    confirmed_by=EXCLUDED.confirmed_by,confirmed_at=EXCLUDED.confirmed_at,
    exclusion_reason=EXCLUDED.exclusion_reason,updated_at=now() RETURNING ${REVIEW_COLUMNS}`, values);
  await appendReviewEvent(client, { entity_type: "review", entity_id: next.id, transaction_id: next.transaction_id,
    action, actor_id: actorId, details: { ...details, before, after: result.rows[0] } });
  return result.rows[0]!;
}

export type SaveReviewBody = ReviewVersions & {
  mode: "categorize" | "match" | "deposit"; matched_deposit_id?: string | null; expected_deposit_source_hash?: string | null; category_list_id?: string | null;
  counterparty_type?: "vendor" | "customer" | null; counterparty_id?: string | null;
  comment: string; matched_payment_id?: string | null;
  expected_match_source_hash?: string | null;
};

export async function saveTransactionReview(id: string, actorId: string, key: string, body: SaveReviewBody) {
  return runReviewCommand({ actorId, key, operation: "review_save", entityId: id, body }, async client => {
    const context = await loadReviewContext(client, id, body);
    if (context.review?.status === "excluded") throw new BankingError("BANKING_RESTORE_REQUIRED", 409);
    const category = body.mode === "categorize" && body.category_list_id
      ? await validateCategory(client, body.category_list_id) : null;
    const match = body.mode === "match" && body.matched_payment_id
      ? await validateMatchedPayment(client, id, body.matched_payment_id) : null;
    if (match) assertMatchSourceHash(body.expected_match_source_hash, match.source_hash, match.legacy_source_hash);
    const deposit = body.mode === "deposit" && body.matched_deposit_id
      ? await validateMatchedDeposit(client, id, body.matched_deposit_id) : null;
    if (deposit) assertDepositSourceHash(body.expected_deposit_source_hash, deposit.source_hash);
    const party = body.mode === "deposit" ? null : match ? { type: "customer" as const, id: match.customer_id, name: match.customer_name }
      : await validateCounterparty(client, body.counterparty_type ?? null, body.counterparty_id ?? null);
    const before = context.review;
    const changed = (before?.mode ?? "categorize") !== body.mode
      || (before?.category_list_id ?? null) !== (category?.id ?? null)
      || (before?.counterparty_type ?? null) !== (party?.type ?? null)
      || (before?.counterparty_id ?? null) !== (party?.id ?? null)
      || (before?.matched_payment_id ?? null) !== (match?.id ?? null)
      || (before?.matched_deposit_id ?? null) !== (deposit?.id ?? null);
    const review = await persistReview(client, context, {
      status: "draft", mode: body.mode, category_list_id: category?.id ?? null,
      category_snapshot: category ? { ...category } : null,
      counterparty_type: party?.type ?? null, counterparty_id: party?.id ?? null,
      counterparty_name: party?.name ?? null, comment: body.comment,
      matched_deposit_id: deposit?.id ?? null, deposit_snapshot: deposit ? { ...deposit } : null,
      matched_payment_id: match?.id ?? null, match_snapshot: match ? { ...match } : null,
      manual_override: Boolean(before?.manual_override || changed),
      origin: changed ? "manual" : before?.origin ?? "manual",
      rule_id: changed ? null : before?.rule_id ?? null, rule_version: changed ? null : before?.rule_version ?? null,
      confirmed_by: null, confirmed_at: null, exclusion_reason: null,
    }, actorId, "review_saved");
    return { review };
  });
}

export async function confirmTransactionReview(id: string, actorId: string, key: string, body: ReviewVersions) {
  return runReviewCommand({ actorId, key, operation: "review_confirm", entityId: id, body }, async client => {
    const context = await loadReviewContext(client, id, body);
    const before = context.review;
    if (!before || before.status !== "draft") throw new BankingError("BANKING_REVIEW_DRAFT_REQUIRED", 409);
    if (context.tx.status !== "posted") throw new BankingError("BANKING_POSTED_TRANSACTION_REQUIRED", 409);
    if (!context.tx.review_start_date || context.tx.opening_bank_balance === null || !context.tx.opening_reference) {
      throw new BankingError("BANKING_ACCOUNT_SETUP_REQUIRED", 409);
    }
    if (before.source_version !== context.tx.source_version) throw new BankingError("BANKING_REVIEW_STALE", 409);
    const party = await validateCounterparty(client, before.counterparty_type, before.counterparty_id);
    const changes: Partial<Review> = { status: "confirmed", confirmed_by: actorId, confirmed_at: new Date(),
      counterparty_name: party?.name ?? null, exclusion_reason: null };
    if (before.mode === "match") {
      if (!before.matched_payment_id) throw new BankingError("BANKING_MATCH_REQUIRED");
      const match = await validateMatchedPayment(client, id, before.matched_payment_id);
      assertMatchSourceHash(before.match_snapshot?.source_hash as string | undefined, match.source_hash, match.legacy_source_hash);
      changes.match_snapshot = { ...match };
      changes.counterparty_type = "customer"; changes.counterparty_id = match.customer_id;
      changes.counterparty_name = match.customer_name;
    } else if (before.mode === "deposit") {
      if (!before.matched_deposit_id) throw new BankingError("BANKING_DEPOSIT_MATCH_INVALID", 409);
      const deposit = await validateMatchedDeposit(client, id, before.matched_deposit_id);
      assertDepositSourceHash(before.deposit_snapshot?.source_hash as string | undefined, deposit.source_hash);
      changes.deposit_snapshot = { ...deposit };
    } else {
      if (!before.category_list_id) throw new BankingError("BANKING_CATEGORY_REQUIRED");
      changes.category_snapshot = { ...await validateCategory(client, before.category_list_id) };
    }
    return { review: await persistReview(client, context, changes, actorId, "review_confirmed") };
  });
}

export async function changeTransactionReviewState(id: string, actorId: string, key: string,
  action: "return" | "exclude", body: ReviewVersions & { reason?: string }) {
  return runReviewCommand({ actorId, key, operation: `review_${action}`, entityId: id, body }, async client => {
    const context = await loadReviewContext(client, id, body);
    if (action === "exclude" && !body.reason?.trim()) throw new BankingError("BANKING_EXCLUSION_REASON_REQUIRED");
    const review = await persistReview(client, context, {
      status: action === "exclude" ? "excluded" : "draft", confirmed_by: null, confirmed_at: null,
      matched_payment_id: null, match_snapshot: null, matched_deposit_id: null, deposit_snapshot: null,
      exclusion_reason: action === "exclude" ? body.reason!.trim() : null,
    }, actorId, `review_${action}`, { reason: body.reason ?? null });
    return { review };
  });
}
