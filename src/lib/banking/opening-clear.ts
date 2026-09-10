import type { PoolClient } from "pg";
import type { z } from "zod";

import { assertOpeningClearMapping } from "./opening-clear-mapping";
import { openingReadItem } from "./opening-funding";
import { openingContext, openingRow } from "./opening-read";
import {
  openingClearSchema,
  openingUnclearSchema,
  type OpeningContext,
} from "./opening-types";
import { openingPeriod } from "./opening-validation";
import { receiptRead, receiptSetup } from "./receipts-setup";
import { reviewCapacity, runReviewCommand } from "./review-common";
import { loadReviewContext, persistReview } from "./review-core";
import { reviewToday } from "./review-date";
import { REVIEW_COLUMNS, type Review } from "./review-types";
import { BankingError, bankingEnvSql } from "./security";
import { bankId } from "./store";

type ClearRow = {
  id: string;
  item_id: string;
  transaction_id: string;
  kind: string;
  source_version: number;
  item_hash: string;
  source_snapshot: Record<string, unknown>;
  review_snapshot: Review | null;
};
const CANDIDATES_SQL = `SELECT t.id,t.name,t.transaction_date AS day,(-t.amount::numeric*100)::float8 AS amount_cents,t.source_version
  FROM bank_transaction t JOIN bank_account a ON a.id=t.account_id JOIN bank_connection conn ON conn.id=a.connection_id
  WHERE a.qb_list_id=$1 AND t.transaction_date>=$2 AND t.transaction_date<=$3 AND t.currency='USD' AND t.status='posted'
    AND t.amount::numeric*100=$4::numeric AND t.deleted_at IS NULL AND a.deleted_at IS NULL AND a.is_active AND a.is_selected
    AND conn.deleted_at IS NULL AND conn.environment=${bankingEnvSql()} AND a.currency='USD' AND a.type='depository'
    AND EXISTS(SELECT 1 FROM qb_account mapped WHERE mapped.qb_list_id=a.qb_list_id AND mapped.is_active
      AND mapped.deleted_at IS NULL AND mapped.account_type='Bank'
      AND (mapped.currency IN ('USD','US Dollar') OR (mapped.currency IS NULL AND $6::boolean)))
    AND NOT EXISTS(SELECT 1 FROM bank_opening_clear c WHERE c.transaction_id=t.id AND c.kind='clear'
      AND NOT EXISTS(SELECT 1 FROM bank_opening_clear u WHERE u.reverses_clear_id=c.id))
    AND NOT EXISTS(SELECT 1 FROM bank_journal_entry e WHERE e.transaction_id=t.id AND e.kind<>'reversal'
      AND NOT EXISTS(SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id=e.id))
    AND NOT EXISTS(SELECT 1 FROM bank_transaction_review r WHERE r.transaction_id=t.id AND r.deleted_at IS NULL
      AND (r.matched_payment_id IS NOT NULL OR r.matched_deposit_id IS NOT NULL))`;
async function clearCandidates(
  client: PoolClient,
  itemId: string,
  transactionId: string | null = null
): Promise<{
  transactions: Array<{
    id: string;
    name: string;
    day: string;
    amount_cents: number;
    source_version: number;
  }>;
  count: number;
}> {
  const item = await openingReadItem(client, itemId),
    opening = await openingRow(client, item.opening_id);
  if (opening.status !== "adopted" || item.kind === "uf_receipt")
    throw new BankingError("BANKING_OPENING_CLEAR_INVALID", 409);
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- guarded by `if (item.blockers.length)`, so index 0 exists
  if (item.blockers.length) throw new BankingError(item.blockers[0]!, 409);
  if (item.clear_id) return { transactions: [], count: 0 };
  // QB Desktop without multicurrency reports NO currency on Bank accounts: the operator's local-USD attestation
  // (same rule as receiptMapping) is what makes the mapped account eligible. Without it, no real account ever
  // produced a candidate (guided-review case 13, 2026-09-10).
  const attested = (await receiptSetup(client))?.attested === true;
  const transactions = (
    await client.query<{
      id: string;
      name: string;
      day: string;
      amount_cents: number;
      source_version: number;
    }>(
      `${CANDIDATES_SQL} AND ($5::text IS NULL OR t.id=$5::text) ORDER BY t.transaction_date,t.id LIMIT 50`,
      [
        opening.account_list_id,
        opening.cut_date,
        reviewToday(),
        item.amount_cents * (item.kind === "outstanding_check" ? 1 : -1),
        transactionId,
        attested,
      ]
    )
  ).rows;
  return { transactions, count: transactions.length };
}
export const listOpeningClearCandidates = (
  id: string
): Promise<{
  transactions: Array<{
    id: string;
    name: string;
    day: string;
    amount_cents: number;
    source_version: number;
  }>;
  count: number;
}> => receiptRead((client) => clearCandidates(client, id));
export async function clearOpeningItem(
  id: string,
  actorId: string,
  key: string,
  input: z.infer<typeof openingClearSchema>
): Promise<OpeningContext> {
  const body = openingClearSchema.parse(input);
  return runReviewCommand(
    { actorId, key, operation: "opening_clear", entityId: id, body },
    async (client) => {
      const item = await openingReadItem(client, id);
      if (item.source_hash !== body.expected_item_hash)
        throw new BankingError("BANKING_OPENING_STALE", 409);
      const candidate = (
        await clearCandidates(client, id, body.transaction_id)
      ).transactions.find((row) => row.id === body.transaction_id);
      if (
        !candidate ||
        candidate.source_version !== body.expected_source_version
      )
        throw new BankingError("BANKING_OPENING_CLEAR_INVALID", 409);
      const before =
        (
          await client.query<Review>(
            `SELECT ${REVIEW_COLUMNS} FROM bank_transaction_review WHERE transaction_id=$1 AND deleted_at IS NULL`,
            [body.transaction_id]
          )
        ).rows[0] ?? null;
      const context = await loadReviewContext(client, body.transaction_id, {
        expected_revision: before?.revision ?? 0,
        expected_source_version: body.expected_source_version,
      });
      const opening = await openingRow(client, item.opening_id);
      await assertOpeningClearMapping(
        client,
        body.transaction_id,
        opening.account_list_id
      );
      await openingPeriod(client, context.tx.transaction_date);
      await reviewCapacity(client, "bank_opening_clear", 2000);
      // The ordinary review is a documentary projection. The immutable claim is the monetary authority.
      await persistReview(
        client,
        context,
        {
          status: "excluded",
          mode: "categorize",
          matched_payment_id: null,
          matched_deposit_id: null,
          match_snapshot: null,
          deposit_snapshot: null,
          confirmed_by: null,
          confirmed_at: null,
          manual_override: true,
          origin: "manual",
          rule_id: null,
          rule_version: null,
          exclusion_reason: `Opening balance item ${item.reference} — cleared with no new entry`,
        },
        actorId,
        "opening_cleared",
        { item_id: id }
      );
      await client.query(
        `INSERT INTO bank_opening_clear(id,item_id,transaction_id,kind,source_version,item_hash,source_snapshot,review_snapshot,actor_id)
      VALUES($1,$2,$3,'clear',$4,$5,$6::jsonb,$7::jsonb,$8)`,
        [
          bankId("boc"),
          id,
          body.transaction_id,
          body.expected_source_version,
          item.source_hash,
          JSON.stringify(context.tx),
          JSON.stringify(before),
          actorId,
        ]
      );
      return openingContext(client, item.opening_id);
    }
  );
}
export async function unclearOpeningItem(
  id: string,
  actorId: string,
  key: string,
  input: z.infer<typeof openingUnclearSchema>
): Promise<OpeningContext> {
  const body = openingUnclearSchema.parse(input);
  return runReviewCommand(
    { actorId, key, operation: "opening_unclear", entityId: id, body },
    async (client) => {
      const original = (
        await client.query<ClearRow>(
          `SELECT id,item_id,transaction_id,kind,source_version,item_hash,source_snapshot,review_snapshot
      FROM bank_opening_clear c WHERE c.id=$1 AND c.item_id=$2 AND c.kind='clear'
      AND NOT EXISTS(SELECT 1 FROM bank_opening_clear u WHERE u.reverses_clear_id=c.id)`,
          [body.clear_id, id]
        )
      ).rows[0];
      if (!original)
        throw new BankingError("BANKING_OPENING_CLEAR_INVALID", 409);
      const item = await openingReadItem(client, id);
      const before =
        (
          await client.query<Review>(
            `SELECT ${REVIEW_COLUMNS} FROM bank_transaction_review WHERE transaction_id=$1 AND deleted_at IS NULL`,
            [original.transaction_id]
          )
        ).rows[0] ?? null;
      const context = await loadReviewContext(client, original.transaction_id, {
        expected_revision: before?.revision ?? 0,
        expected_source_version:
          body.expected_source_version ?? original.source_version,
      });
      await openingPeriod(client, context.tx.transaction_date);
      await reviewCapacity(client, "bank_opening_clear", 2000);
      await client.query(
        `INSERT INTO bank_opening_clear(id,item_id,transaction_id,kind,reverses_clear_id,source_version,item_hash,source_snapshot,actor_id,reason)
      VALUES($1,$2,$3,'unclear',$4,$5,$6,$7::jsonb,$8,$9)`,
        [
          bankId("boc"),
          id,
          original.transaction_id,
          original.id,
          context.tx.source_version,
          original.item_hash,
          JSON.stringify(context.tx),
          actorId,
          body.reason,
        ]
      );
      const restore: Partial<Review> = (context.tx.source_version ===
      original.source_version
        ? original.review_snapshot
        : null) ?? {
        status: "draft",
        mode: "categorize",
        category_list_id: null,
        category_snapshot: null,
        comment: "",
        matched_payment_id: null,
        matched_deposit_id: null,
        match_snapshot: null,
        deposit_snapshot: null,
        exclusion_reason: null,
        confirmed_by: null,
        confirmed_at: null,
        origin: "manual",
        rule_id: null,
        rule_version: null,
      };
      await persistReview(
        client,
        context,
        restore,
        actorId,
        "opening_uncleared",
        { item_id: id, reason: body.reason }
      );
      return openingContext(client, item.opening_id);
    }
  );
}
