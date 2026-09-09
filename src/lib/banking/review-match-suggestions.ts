import { z } from "zod";

import { getDbPool } from "../../api/utils/db-pool";

import { depositSuggestions, type DepositSuggestion } from "./deposit-matching";
import { reviewDate } from "./review-date";
import {
  MATCH_FROM_SQL,
  MATCH_RANK_FIELDS_SQL,
  MATCH_SELECT_SQL,
  MATCH_VALID_SQL,
} from "./review-matching";
import {
  bankingConfig,
  BankingError,
  requireBankingEnabled,
  bankingEnvSql,
} from "./security";

const idsSchema = z
  .string()
  .max(12900)
  .transform((value) => value.split(","))
  .pipe(
    z
      .array(z.string().regex(/^[A-Za-z0-9_-]{1,128}$/))
      .min(1)
      .max(100)
  )
  .refine(
    (ids) => new Set(ids).size === ids.length,
    "Duplicate transaction IDs"
  );
export const matchSuggestionsQuery = z
  .object({ ids: idsSchema.optional(), date: reviewDate.optional() })
  .strict()
  .refine(
    (value) => Boolean(value.ids) !== Boolean(value.date),
    "Provide IDs or date"
  );
export type SuggestionBest = {
  id: string;
  display_id: number | null;
  customer_id: string;
  customer_name: string;
  date: string;
  reference: string | null;
  source_hash: string;
};
export type MatchSuggestion = {
  transaction_id: string;
  candidate_count: number;
  best: SuggestionBest | null;
  reason: string;
  ambiguous: boolean;
};
type SuggestionRow = {
  transaction_id: string;
  candidate_count: string;
  best: SuggestionBest | null;
  reference_match: boolean | null;
  date_distance: number | null;
};

export function summarizeMatchSuggestion(row: SuggestionRow): MatchSuggestion {
  const count = Number(row.candidate_count);
  if (!Number.isSafeInteger(count) || count < 0)
    throw new BankingError("BANKING_COUNT_INVALID", 500);
  const reason =
    count === 0
      ? "No individual receipt matches this amount and currency."
      : `${count > 1 ? "Multiple receipts match" : "Same amount and currency"}${row.reference_match ? "; reference matches" : ""}` +
        (row.date_distance === 0
          ? "; same date."
          : `; ${row.date_distance} day(s) apart.`);
  return {
    transaction_id: row.transaction_id,
    candidate_count: count,
    best: row.best,
    reason,
    ambiguous: count > 1,
  };
}

/** Read-only overlay. Never called by source ingestion, daily hashes or snapshot writers. */
export async function matchSuggestions(input: {
  ids?: string[];
  date?: string;
}): Promise<{
  suggestions: Array<
    MatchSuggestion & {
      deposit_count: number;
      best_deposit: DepositSuggestion["best_deposit"] | null;
    }
  >;
}> {
  if (
    Boolean(input.ids) === Boolean(input.date) ||
    (input.ids &&
      (!input.ids.length ||
        input.ids.length > 100 ||
        new Set(input.ids).size !== input.ids.length ||
        input.ids.some((id) => !/^[A-Za-z0-9_-]{1,128}$/.test(id)))) ||
    (input.date !== undefined && !reviewDate.safeParse(input.date).success)
  )
    throw new BankingError("BANKING_INVALID_REQUEST");
  if (!bankingConfig().enabled) return { suggestions: [] };
  requireBankingEnabled();
  const result = await getDbPool().query<SuggestionRow>(
    `WITH bank_scope AS (
    SELECT t.id FROM bank_transaction t JOIN bank_account a ON a.id=t.account_id
    JOIN bank_connection bc ON bc.id=a.connection_id
    LEFT JOIN bank_transaction_review r ON r.transaction_id=t.id AND r.deleted_at IS NULL
    LEFT JOIN bank_day_close dc ON dc.day=t.transaction_date AND dc.deleted_at IS NULL
    WHERE (($1::text[] IS NOT NULL AND t.id=ANY($1::text[])) OR ($2::text IS NOT NULL AND t.transaction_date=$2::text))
      AND t.deleted_at IS NULL AND a.deleted_at IS NULL AND bc.deleted_at IS NULL AND bc.environment=${bankingEnvSql()}
      AND a.type='depository' AND t.status='posted' AND t.amount::numeric<0 AND t.currency IS NOT NULL
      AND a.review_start_date IS NOT NULL AND t.transaction_date>=a.review_start_date
      AND COALESCE(r.status,'draft') NOT IN ('confirmed','excluded') AND COALESCE(dc.status,'open')<>'closed'
  ), eligible AS (
    SELECT t.id AS transaction_id,${MATCH_SELECT_SQL},${MATCH_RANK_FIELDS_SQL}
    ${MATCH_FROM_SQL} JOIN bank_scope bs ON bs.id=t.id WHERE ${MATCH_VALID_SQL}
  ), ranked AS (
    SELECT transaction_id,id,display_id,customer_id,customer_name,date,reference,source_hash,reference_match,date_distance,
      COUNT(*) OVER (PARTITION BY transaction_id)::text AS candidate_count,
      ROW_NUMBER() OVER (PARTITION BY transaction_id ORDER BY reference_match DESC,date_distance,id) AS rank
    FROM eligible
  )
  SELECT bs.id AS transaction_id,COALESCE(r.candidate_count,'0') AS candidate_count,
    r.reference_match,r.date_distance,CASE WHEN r.id IS NULL THEN NULL ELSE jsonb_build_object(
      'id',r.id,'display_id',r.display_id,'customer_id',r.customer_id,'customer_name',r.customer_name,
      'date',r.date,'reference',r.reference,'source_hash',r.source_hash) END AS best
  FROM bank_scope bs LEFT JOIN ranked r ON r.transaction_id=bs.id AND r.rank=1 ORDER BY bs.id`,
    [input.ids ?? null, input.date ?? null]
  );
  const deposits = new Map(
    (
      await depositSuggestions(result.rows.map((row) => row.transaction_id))
    ).map((row) => [row.transaction_id, row])
  );
  return {
    suggestions: result.rows.map((row) => ({
      ...summarizeMatchSuggestion(row),
      deposit_count: deposits.get(row.transaction_id)?.deposit_count ?? 0,
      best_deposit: deposits.get(row.transaction_id)?.best_deposit ?? null,
    })),
  };
}
