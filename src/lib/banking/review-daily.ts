import { assertDepositSourceHash, validateMatchedDeposit } from "./deposit-matching";
import { z } from "zod";
import { BankingError } from "./security";
import { bankId } from "./store";
import { appendReviewEvent, reviewCapacity, runReviewCommand } from "./review-common";
import { reviewDate } from "./review-date";
import { loadDailyInputs, loadDayClose } from "./review-daily-read";
import { validateCategory, validateCounterparty } from "./review-lookups";
import { validateMatchedPayment } from "./review-matching";
import { applyRulesForAccounts } from "./review-rule-apply";

export const dailyConfirmSchema = z.object({ date: reviewDate, expected_revision: z.number().int().min(0),
  input_hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const dailyReopenSchema = z.object({ date: reviewDate, expected_revision: z.number().int().min(1),
  reason: z.string().trim().min(1).max(1000) }).strict();

export async function confirmDailyReview(actorId: string, key: string | undefined,
  body: z.infer<typeof dailyConfirmSchema>) {
  return runReviewCommand({ actorId, operation: "close_day", entityId: body.date, key, body }, async client => {
    const day = await loadDayClose(client, body.date);
    if ((day?.revision ?? 0) !== body.expected_revision) throw new BankingError("BANKING_REVIEW_CONFLICT", 409);
    if (day?.status === "closed") throw new BankingError("BANKING_DAY_CLOSED", 409);
    const live = await loadDailyInputs(client, body.date);
    if (live.input_hash !== body.input_hash) throw new BankingError("BANKING_DAY_CHANGED", 409);
    if (live.blockers.length) throw new BankingError("BANKING_DAY_NOT_READY", 409);
    for (const block of live.snapshot.accounts.filter(item => item.applicable)) {
      for (const row of block.transactions) {
        const review = row.review;
        if (row.status !== "posted" || !review || review.status === "excluded") continue;
        await validateCounterparty(client, review.counterparty_type, review.counterparty_id);
        if (review.mode === "match") {
          const match = await validateMatchedPayment(client, row.id, review.matched_payment_id ?? "");
          if (match.source_hash !== review.match_snapshot?.source_hash) throw new BankingError("BANKING_MATCH_CHANGED", 409);
        } else if (review.mode === "deposit") {
          const deposit = await validateMatchedDeposit(client, row.id, review.matched_deposit_id ?? "");
          assertDepositSourceHash(review.deposit_snapshot?.source_hash as string | undefined, deposit.source_hash);
        } else {
          if (!review.category_list_id) throw new BankingError("BANKING_CATEGORY_REQUIRED", 409);
          await validateCategory(client, review.category_list_id);
        }
      }
    }
    if (!day) await reviewCapacity(client, "bank_day_close", 62);
    const revision = (day?.revision ?? 0) + 1;
    const snapshot = { ...live.snapshot, accounts: live.snapshot.accounts.map(block => ({ ...block,
      transactions: block.transactions.map(row => ({ ...row, day_closed: true, review_status: "closed" })) })) };
    await client.query(`INSERT INTO bank_day_close
      (id,day,revision,status,snapshot,input_hash,closed_by,closed_at,needs_review)
      VALUES($1,$2,$3,'closed',$4::jsonb,$5,$6,now(),false)
      ON CONFLICT(day) DO UPDATE SET revision=EXCLUDED.revision,status='closed',snapshot=EXCLUDED.snapshot,
        input_hash=EXCLUDED.input_hash,closed_by=EXCLUDED.closed_by,closed_at=now(),needs_review=false,updated_at=now()`,
    [day?.id ?? bankId("bdc"), body.date, revision, JSON.stringify(snapshot), live.input_hash, actorId]);
    await appendReviewEvent(client, { entity_type: "day", entity_id: body.date, action: "day_closed",
      actor_id: actorId, details: { revision, input_hash: live.input_hash } });
    return { date: body.date, status: "closed" as const, revision };
  });
}

export async function reopenDailyReview(actorId: string, key: string | undefined,
  body: z.infer<typeof dailyReopenSchema>) {
  return runReviewCommand({ actorId, operation: "reopen_day", entityId: body.date, key, body }, async client => {
    const day = await loadDayClose(client, body.date);
    if (!day || day.revision !== body.expected_revision) throw new BankingError("BANKING_REVIEW_CONFLICT", 409);
    if (day.status !== "closed" || !day.snapshot) throw new BankingError("BANKING_DAY_NOT_CLOSED", 409);
    const history = [...day.history, { revision: day.revision, status: "closed", snapshot: day.snapshot,
      input_hash: day.input_hash, closed_by: day.closed_by, closed_at: day.closed_at,
      reopened_by: actorId, reopened_at: new Date().toISOString(), reopen_reason: body.reason }];
    const revision = day.revision + 1;
    await client.query(`UPDATE bank_day_close SET status='open',revision=$2,history=$3::jsonb,
      reopened_by=$4,reopened_at=now(),reopen_reason=$5,needs_review=false,
      snapshot=NULL,input_hash=NULL,closed_by=NULL,closed_at=NULL,updated_at=now() WHERE id=$1`,
    [day.id, revision, JSON.stringify(history), actorId, body.reason]);
    await appendReviewEvent(client, { entity_type: "day", entity_id: body.date, action: "day_reopened",
      actor_id: actorId, details: { revision, previous_revision: day.revision, reason: body.reason } });
    await applyRulesForAccounts(client, day.snapshot.accounts.map(block => block.account.id), actorId);
    return { date: body.date, status: "open" as const, revision };
  });
}
