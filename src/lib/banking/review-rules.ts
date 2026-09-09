import { z } from "zod";
import type { PoolClient } from "pg";
import { getDbPool } from "../../api/utils/db-pool";
import { bankId as bankIdSchema } from "../../api/admin/banking/_lib/http";
import { BankingError, requireBankingEnabled, bankingEnvSql } from "./security";
import { appendReviewEvent, runReviewCommand, stableReviewHash, withReviewLock } from "./review-common";
import { validateCategory, validateCounterparty } from "./review-lookups";
import { applyRuleChanges, planRuleChanges, type ReviewRule } from "./review-rule-apply";
import { transaction } from "./store";

export const ruleSchema = z.object({
  id: bankIdSchema.optional(), expected_version: z.number().int().min(1).optional(),
  name: z.string().trim().min(1).max(120), account_id: bankIdSchema,
  active: z.boolean(), priority: z.number().int().min(0).max(10000),
  match_field: z.enum(["merchant", "description"]), pattern: z.string().trim().min(2).max(200),
  direction: z.enum(["in", "out"]), currency: z.string().regex(/^[A-Za-z]{3}$/).transform(value => value.toUpperCase()),
  category_list_id: z.string().min(1).max(128),
  counterparty_type: z.enum(["vendor", "customer"]).nullable().optional(),
  counterparty_id: bankIdSchema.nullable().optional(),
}).strict();
export const ruleSaveSchema = ruleSchema.extend({ preview_hash: z.string().regex(/^[a-f0-9]{64}$/) });
type RuleInput = z.infer<typeof ruleSchema>;

async function prepare(client: PoolClient, actorId: string, input: RuleInput) {
  const existing = input.id ? (await client.query<ReviewRule>(
    "SELECT * FROM bank_review_rule WHERE id=$1 AND deleted_at IS NULL", [input.id])).rows[0] : null;
  if (input.id && !existing) throw new BankingError("BANKING_RULE_NOT_FOUND", 404);
  if (existing && existing.version !== input.expected_version) throw new BankingError("BANKING_REVIEW_CONFLICT", 409);
  const account = (await client.query<{ currency: string | null; review_start_date: string | null }>(
    `SELECT a.currency,a.review_start_date FROM bank_account a JOIN bank_connection c ON c.id=a.connection_id
     WHERE a.id=$1 AND a.deleted_at IS NULL AND c.deleted_at IS NULL AND c.environment=${bankingEnvSql()}`, [input.account_id])).rows[0];
  if (!account) throw new BankingError("BANKING_ACCOUNT_NOT_FOUND", 404);
  if (!account.review_start_date) throw new BankingError("BANKING_SETUP_REQUIRED", 409);
  if (account.currency?.toUpperCase() !== input.currency) throw new BankingError("BANKING_CURRENCY_MISMATCH", 409);
  await validateCategory(client, input.category_list_id);
  const party = await validateCounterparty(client, input.counterparty_type ?? null, input.counterparty_id ?? null);
  // Stable draft identity makes equal-priority ordering identical in preview and save.
  const id = input.id ?? `brule_${stableReviewHash({ actorId, input }).slice(0, 32)}`;
  if (!existing && (await client.query("SELECT id FROM bank_review_rule WHERE id=$1", [id])).rowCount) {
    throw new BankingError("BANKING_RULE_ALREADY_EXISTS", 409);
  }
  const candidate: ReviewRule = { id, version: (existing?.version ?? 0) + 1,
    name: input.name, account_id: input.account_id, active: input.active, priority: input.priority,
    match_field: input.match_field, pattern: input.pattern, direction: input.direction, currency: input.currency,
    category_list_id: input.category_list_id, counterparty_type: party?.type ?? null,
    counterparty_id: party?.id ?? null, counterparty_name: party?.name ?? null };
  const accountIds = [...new Set([input.account_id, ...(existing ? [existing.account_id] : [])])];
  const plan = await planRuleChanges(client, accountIds, candidate);
  return { ...plan, candidate, existing };
}

export async function listReviewRules() {
  requireBankingEnabled();
  const rules = (await getDbPool().query(`SELECT r.*,q.full_name AS category_name,q.account_type,
    a.name AS account_name FROM bank_review_rule r JOIN bank_account a ON a.id=r.account_id
    LEFT JOIN qb_account q ON q.qb_list_id=r.category_list_id AND q.deleted_at IS NULL
    WHERE r.deleted_at IS NULL ORDER BY r.priority,r.id`)).rows;
  return { rules, count: rules.length };
}

export async function previewReviewRule(actorId: string, input: RuleInput) {
  requireBankingEnabled();
  const client = await getDbPool().connect();
  try {
    return await transaction(client, async () => {
      await withReviewLock(client);
      const { preview_hash, affected_count, days, skipped_manual, skipped_closed } = await prepare(client, actorId, input);
      return { preview_hash, affected_count, days, skipped_manual, skipped_closed };
    });
  } finally { client.release(); }
}

export async function saveReviewRule(actorId: string, key: string | undefined, body: z.infer<typeof ruleSaveSchema>) {
  const { preview_hash, ...input } = body;
  return runReviewCommand({ actorId, operation: "save_rule", entityId: input.id ?? "new", key, body }, async client => {
    const plan = await prepare(client, actorId, input);
    if (plan.preview_hash !== preview_hash) throw new BankingError("BANKING_RULE_PREVIEW_STALE", 409);
    if (!plan.existing && Number((await client.query("SELECT count(*) AS n FROM bank_review_rule")).rows[0].n) >= 100) {
      throw new BankingError("BANKING_RULE_LIMIT", 409);
    }
    const rule = plan.candidate;
    await client.query(`INSERT INTO bank_review_rule
      (id,version,name,account_id,active,priority,match_field,pattern,direction,currency,category_list_id,
       counterparty_type,counterparty_id,counterparty_name,created_by,updated_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15)
      ON CONFLICT(id) DO UPDATE SET version=EXCLUDED.version,name=EXCLUDED.name,account_id=EXCLUDED.account_id,
        active=EXCLUDED.active,priority=EXCLUDED.priority,match_field=EXCLUDED.match_field,pattern=EXCLUDED.pattern,
        direction=EXCLUDED.direction,currency=EXCLUDED.currency,category_list_id=EXCLUDED.category_list_id,
        counterparty_type=EXCLUDED.counterparty_type,counterparty_id=EXCLUDED.counterparty_id,
        counterparty_name=EXCLUDED.counterparty_name,updated_by=EXCLUDED.updated_by,updated_at=now()`,
    [rule.id, rule.version, rule.name, rule.account_id, rule.active, rule.priority, rule.match_field, rule.pattern,
      rule.direction, rule.currency, rule.category_list_id, rule.counterparty_type, rule.counterparty_id, rule.counterparty_name, actorId]);
    await appendReviewEvent(client, { entity_type: "rule", entity_id: rule.id, action: "rule_version",
      actor_id: actorId, details: { before: plan.existing, after: rule, affected_count: plan.affected_count } });
    await applyRuleChanges(client, plan.changes, actorId);
    return { rule, applied_count: plan.affected_count };
  });
}
