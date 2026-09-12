import type { PoolClient } from "pg";

import { assertNoJournalClaim } from "./journal-claim";
import { appendReviewEvent, stableReviewHash } from "./review-common";
import { BankingError } from "./security";
import { bankId } from "./store";

export type ReviewRule = {
  id: string;
  version: number;
  name: string;
  account_id: string;
  active: boolean;
  priority: number;
  match_field: "merchant" | "description";
  pattern: string;
  direction: "in" | "out";
  currency: string;
  category_list_id: string;
  counterparty_type: "vendor" | "customer" | null;
  counterparty_id: string | null;
  counterparty_name: string | null;
};
type ExistingReview = {
  id: string;
  revision: number;
  source_version: number;
  status: string;
  mode: string;
  category_list_id: string | null;
  counterparty_type: string | null;
  counterparty_id: string | null;
  origin: string;
  rule_id: string | null;
  rule_version: number | null;
  manual_override: boolean;
};
type RuleSource = {
  id: string;
  account_id: string;
  transaction_date: string;
  source_version: number;
  amount: string;
  currency: string | null;
  name: string;
  merchant_name: string | null;
  setup_revision: number;
  closed_revision: number | null;
  review: ExistingReview | null;
};
export type RuleChange = { source: RuleSource; rule: ReviewRule | null };
const normalize = (value: string): string =>
  value
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("en-US");

export function ruleMatches(rule: ReviewRule, row: RuleSource): boolean {
  return (
    rule.account_id === row.account_id &&
    rule.currency === row.currency?.toUpperCase() &&
    /[1-9]/.test(row.amount) &&
    rule.direction === (row.amount.startsWith("-") ? "in" : "out") &&
    normalize(
      rule.match_field === "merchant" ? (row.merchant_name ?? "") : row.name
    ).includes(normalize(rule.pattern))
  );
}

export async function planRuleChanges(
  client: PoolClient,
  accountIds: string[],
  candidate?: ReviewRule
): Promise<{
  changes: RuleChange[];
  rules: ReviewRule[];
  preview_hash: string;
  affected_count: number;
  days: string[];
  skipped_manual: number;
  skipped_closed: number;
}> {
  const stored = (
    await client.query<ReviewRule>(
      `SELECT id,version,name,account_id,active,priority,
    match_field,pattern,direction,currency,category_list_id,counterparty_type,counterparty_id,counterparty_name
    FROM bank_review_rule WHERE deleted_at IS NULL AND account_id=ANY($1::text[])`,
      [accountIds]
    )
  ).rows;
  const rules = [
    ...stored.filter((rule) => rule.id !== candidate?.id),
    ...(candidate ? [candidate] : []),
  ].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  const eligibleCategories = new Set(
    (
      await client.query<{ qb_list_id: string }>(
        `SELECT qb_list_id FROM qb_account WHERE is_active AND deleted_at IS NULL AND account_type<>'NonPosting'`
      )
    ).rows.map((row) => row.qb_list_id)
  );
  const sources = (
    await client.query<RuleSource>(
      `SELECT t.id,t.account_id,t.transaction_date,t.source_version,
    t.amount,t.currency,t.name,t.merchant_name,a.setup_revision,dc.revision AS closed_revision,
    CASE WHEN r.id IS NULL THEN NULL ELSE to_jsonb(r)-'created_at'-'updated_at'-'deleted_at' END AS review
    FROM bank_transaction t JOIN bank_account a ON a.id=t.account_id
    LEFT JOIN bank_transaction_review r ON r.transaction_id=t.id AND r.deleted_at IS NULL
    LEFT JOIN bank_day_close dc ON dc.day=t.transaction_date AND dc.status='closed' AND dc.deleted_at IS NULL
    WHERE t.account_id=ANY($1::text[]) AND t.status='posted' AND t.deleted_at IS NULL
      AND a.review_start_date IS NOT NULL AND t.transaction_date>=a.review_start_date
    ORDER BY t.transaction_date,t.id`,
      [accountIds]
    )
  ).rows;
  const changes: RuleChange[] = [];
  let skipped_manual = 0;
  let skipped_closed = 0;
  for (const source of sources) {
    const current = source.review;
    const relevant = candidate
      ? ruleMatches(candidate, source) || current?.rule_id === candidate.id
      : true;
    if (source.closed_revision !== null) {
      if (relevant) skipped_closed++;
      continue;
    }
    if (current?.manual_override || current?.status === "excluded") {
      if (relevant) skipped_manual++;
      continue;
    }
    const rule =
      rules.find(
        (rule) =>
          rule.active &&
          eligibleCategories.has(rule.category_list_id) &&
          ruleMatches(rule, source)
      ) ?? null;
    if (!rule && current?.origin !== "rule") continue;
    if (
      rule &&
      current?.rule_id === rule.id &&
      current.rule_version === rule.version &&
      current.source_version === source.source_version &&
      current.mode === "categorize" &&
      current.category_list_id === rule.category_list_id &&
      current.counterparty_id === rule.counterparty_id &&
      current.counterparty_type === rule.counterparty_type
    )
      continue;
    changes.push({ source, rule });
  }
  return {
    changes,
    rules,
    preview_hash: stableReviewHash({
      candidate,
      rules,
      sources,
      eligible_categories: [...eligibleCategories].sort(),
      changes,
    }),
    affected_count: changes.length,
    days: [
      ...new Set(changes.map((item) => item.source.transaction_date)),
    ].sort(),
    skipped_manual,
    skipped_closed,
  };
}

/** Caller holds the review transaction lock. Comments and attachment evidence are untouched. */
export async function applyRuleChanges(
  client: PoolClient,
  changes: RuleChange[],
  actorId: string
): Promise<void> {
  const count = Number(
    (await client.query("SELECT count(*) AS n FROM bank_transaction_review"))
      .rows[0].n
  );
  if (count + changes.filter((change) => !change.source.review).length > 2000)
    throw new BankingError("BANKING_REVIEW_LIMIT", 409);
  for (const { source, rule } of changes) {
    await assertNoJournalClaim(client, source.id);
    const before = source.review;
    const id = before?.id ?? bankId("brvw");
    await client.query(
      `INSERT INTO bank_transaction_review
      (id,transaction_id,revision,source_version,status,mode,category_list_id,counterparty_type,counterparty_id,
       counterparty_name,origin,rule_id,rule_version,manual_override,comment)
      VALUES($1,$2,1,$3,'draft','categorize',$4,$5,$6,$7,$8,$9,$10,false,'')
      ON CONFLICT(transaction_id) DO UPDATE SET revision=bank_transaction_review.revision+1,
        source_version=EXCLUDED.source_version,status='draft',mode='categorize',category_list_id=EXCLUDED.category_list_id,
        counterparty_type=EXCLUDED.counterparty_type,counterparty_id=EXCLUDED.counterparty_id,
        counterparty_name=EXCLUDED.counterparty_name,origin=EXCLUDED.origin,rule_id=EXCLUDED.rule_id,
        rule_version=EXCLUDED.rule_version,confirmed_by=NULL,confirmed_at=NULL,
        matched_payment_id=NULL,match_snapshot=NULL,category_snapshot=NULL,updated_at=now()`,
      [
        id,
        source.id,
        source.source_version,
        rule?.category_list_id ?? null,
        rule?.counterparty_type ?? null,
        rule?.counterparty_id ?? null,
        rule?.counterparty_name ?? null,
        rule ? "rule" : "manual",
        rule?.id ?? null,
        rule?.version ?? null,
      ]
    );
    await appendReviewEvent(client, {
      entity_type: "transaction",
      entity_id: source.id,
      transaction_id: source.id,
      action: rule ? "rule_applied" : "rule_cleared",
      actor_id: actorId,
      details: {
        before,
        rule_id: rule?.id ?? null,
        rule_version: rule?.version ?? null,
      },
    });
  }
}

export async function applyRulesForAccounts(
  client: PoolClient,
  accountIds: string[],
  actorId = "system"
): Promise<void> {
  if (!accountIds.length) return;
  // ATAJO: scan bounded to 2,000 sandbox transactions; replace with measured batching before production scale.
  const plan = await planRuleChanges(client, accountIds);
  await applyRuleChanges(client, plan.changes, actorId);
}
