import { z } from "zod";

import {
  depositAccount,
  loadBankDeposit,
  type DepositCandidate,
} from "./deposit-read";
import {
  depositMajor,
  depositCents,
  depositSourceKey,
  depositTotals,
  depositSaveSchema,
  depositReadySchema,
  depositVoidSchema,
  type DepositSaveBody,
  type BankDeposit,
} from "./deposit-types";
import {
  guardDepositEdit,
  invalidateDepositReviews,
  validateDepositFee,
  validateDepositFunding,
} from "./deposit-validation";
import {
  appendReviewEvent,
  reviewCapacity,
  runReviewCommand,
} from "./review-common";
import { BankingError } from "./security";
import { bankId } from "./store";

export async function saveBankDeposit(
  actorId: string,
  key: string | undefined,
  input: DepositSaveBody
): Promise<{ deposit: BankDeposit }> {
  const parsed = depositSaveSchema.safeParse(input);
  if (!parsed.success) throw new BankingError("BANKING_INVALID_REQUEST");
  const body = parsed.data;
  return runReviewCommand(
    {
      actorId,
      key,
      operation: "deposit_save",
      entityId: body.id ?? "new",
      body,
    },
    async (client) => {
      const before = body.id ? await loadBankDeposit(client, body.id) : null;
      if ((before?.revision ?? 0) !== body.expected_revision)
        throw new BankingError("BANKING_DEPOSIT_CONFLICT", 409);
      if (before?.status === "void")
        throw new BankingError("BANKING_DEPOSIT_VOID", 409);
      if (before) await guardDepositEdit(client, before.id);
      const account = await depositAccount(client, body.account_id);
      if (
        body.date <
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- depositAccount() throws BANKING_ACCOUNT_SETUP_REQUIRED if review_start_date is null
        account.review_start_date!
      )
        throw new BankingError("BANKING_TRANSACTION_BEFORE_REVIEW_START", 409);
      const totals = depositTotals(body.lines, body.fee_amount);
      const fee = await validateDepositFee(
        client,
        totals.fee_amount,
        body.fee_account_list_id,
        body.fee_reference
      );
      const payments = new Map<string, DepositCandidate>();
      for (const line of [...body.lines].sort((a, b) =>
        depositSourceKey(a).localeCompare(depositSourceKey(b))
      )) {
        payments.set(
          depositSourceKey(line),
          await validateDepositFunding(
            client,
            line,
            before?.id ?? null,
            account.currency,
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- depositAccount() throws BANKING_ACCOUNT_SETUP_REQUIRED if review_start_date is null
            account.review_start_date!,
            body.date,
            line.expected_source_hash
          )
        );
      }
      const id = before?.id ?? bankId("bdep");
      if (!before) await reviewCapacity(client, "bank_deposit", 100);
      await client.query(
        `INSERT INTO bank_deposit (id,revision,status,account_id,currency,deposit_date,reference,memo,
      gross_amount,fee_amount,fee_account_list_id,fee_reference,fee_account_snapshot,net_amount,created_by)
      VALUES($1,$2,'draft',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14)
      ON CONFLICT(id) DO UPDATE SET revision=EXCLUDED.revision,status='draft',account_id=EXCLUDED.account_id,
        currency=EXCLUDED.currency,deposit_date=EXCLUDED.deposit_date,reference=EXCLUDED.reference,memo=EXCLUDED.memo,
        gross_amount=EXCLUDED.gross_amount,fee_amount=EXCLUDED.fee_amount,fee_account_list_id=EXCLUDED.fee_account_list_id,
        fee_reference=EXCLUDED.fee_reference,fee_account_snapshot=EXCLUDED.fee_account_snapshot,
        net_amount=EXCLUDED.net_amount,ready_by=NULL,ready_at=NULL,updated_at=now()`,
        [
          id,
          (before?.revision ?? 0) + 1,
          body.account_id,
          account.currency,
          body.date,
          body.reference,
          body.memo,
          totals.gross_amount,
          totals.fee_amount,
          fee?.id ?? null,
          fee
            ? // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- validateDepositFee() only returns non-null when reference?.trim() was truthy
              body.fee_reference!.trim()
            : null,
          JSON.stringify(fee),
          totals.net_amount,
          actorId,
        ]
      );
      await client.query(
        `UPDATE bank_deposit_line SET deleted_at=now(),updated_at=now()
      WHERE deposit_id=$1 AND NOT(COALESCE(payment_id=ANY($2::text[]),false)
        OR COALESCE(opening_item_id=ANY($3::text[]),false)) AND deleted_at IS NULL`,
        [
          id,
          body.lines.flatMap((line) =>
            "payment_id" in line ? [line.payment_id] : []
          ),
          body.lines.flatMap((line) =>
            "opening_item_id" in line ? [line.opening_item_id] : []
          ),
        ]
      );
      for (const line of body.lines) {
        const paymentId = "payment_id" in line ? line.payment_id : null;
        const openingItemId =
          "opening_item_id" in line ? line.opening_item_id : null;
        const existing = await client.query<{ id: string }>(
          `SELECT id FROM bank_deposit_line WHERE deposit_id=$1
        AND (($2::text IS NOT NULL AND payment_id=$2) OR ($3::text IS NOT NULL AND opening_item_id=$3))
        ORDER BY deleted_at NULLS FIRST,id LIMIT 1`,
          [id, paymentId, openingItemId]
        );
        if (!existing.rows[0])
          await reviewCapacity(client, "bank_deposit_line", 2000);
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- payments was populated by iterating this same body.lines, so every line's key is present
        const payment = payments.get(depositSourceKey(line))!;
        await client.query(
          `INSERT INTO bank_deposit_line(id,deposit_id,payment_id,opening_item_id,amount,source_hash,payment_snapshot)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT(id) DO UPDATE SET amount=EXCLUDED.amount,
          source_hash=EXCLUDED.source_hash,payment_snapshot=EXCLUDED.payment_snapshot,deleted_at=NULL,updated_at=now()`,
          [
            existing.rows[0]?.id ?? bankId("bdl"),
            id,
            paymentId,
            openingItemId,
            depositMajor(depositCents(line.amount)),
            payment.source_hash,
            JSON.stringify(payment),
          ]
        );
      }
      if (before)
        await invalidateDepositReviews(client, before, actorId, false);
      const deposit = await loadBankDeposit(client, id);
      await appendReviewEvent(client, {
        entity_type: "deposit",
        entity_id: id,
        action: "deposit_saved",
        actor_id: actorId,
        details: { before, after: deposit },
      });
      return { deposit };
    }
  );
}
export async function readyBankDeposit(
  id: string,
  actorId: string,
  key: string | undefined,
  body: z.infer<typeof depositReadySchema>
): Promise<{ deposit: BankDeposit }> {
  if (!depositReadySchema.safeParse(body).success)
    throw new BankingError("BANKING_INVALID_REQUEST");
  return runReviewCommand(
    { actorId, key, operation: "deposit_ready", entityId: id, body },
    async (client) => {
      const before = await loadBankDeposit(client, id);
      if (before.revision !== body.expected_revision)
        throw new BankingError("BANKING_DEPOSIT_CONFLICT", 409);
      if (before.status === "void")
        throw new BankingError("BANKING_DEPOSIT_VOID", 409);
      if (before.stale || before.source_hash !== body.expected_source_hash)
        throw new BankingError("BANKING_DEPOSIT_SOURCE_STALE", 409);
      await guardDepositEdit(client, id);
      const account = await depositAccount(client, before.account_id);
      await validateDepositFee(
        client,
        before.fee_amount,
        before.fee_account_list_id,
        before.fee_reference
      );
      for (const line of [...before.lines].sort((a, b) =>
        depositSourceKey(a).localeCompare(depositSourceKey(b))
      )) {
        await validateDepositFunding(
          client,
          line,
          id,
          before.currency,
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- depositAccount() throws BANKING_ACCOUNT_SETUP_REQUIRED if review_start_date is null
          account.review_start_date!,
          before.date,
          line.source_hash
        );
      }
      await client.query(
        "UPDATE bank_deposit SET status='ready',revision=revision+1,ready_by=$2,ready_at=now(),updated_at=now() WHERE id=$1",
        [id, actorId]
      );
      await invalidateDepositReviews(client, before, actorId, false);
      const deposit = await loadBankDeposit(client, id);
      await appendReviewEvent(client, {
        entity_type: "deposit",
        entity_id: id,
        action: "deposit_ready",
        actor_id: actorId,
        details: { before, after: deposit },
      });
      return { deposit };
    }
  );
}
export async function voidBankDeposit(
  id: string,
  actorId: string,
  key: string | undefined,
  body: z.infer<typeof depositVoidSchema>
): Promise<{ deposit: BankDeposit }> {
  if (!depositVoidSchema.safeParse(body).success)
    throw new BankingError("BANKING_INVALID_REQUEST");
  return runReviewCommand(
    { actorId, key, operation: "deposit_void", entityId: id, body },
    async (client) => {
      const before = await loadBankDeposit(client, id);
      if (before.revision !== body.expected_revision)
        throw new BankingError("BANKING_DEPOSIT_CONFLICT", 409);
      if (before.status === "void")
        throw new BankingError("BANKING_DEPOSIT_VOID", 409);
      await guardDepositEdit(client, id);
      await client.query(
        `UPDATE bank_deposit SET status='void',revision=revision+1,voided_by=$2,voided_at=now(),
      void_reason=$3,updated_at=now() WHERE id=$1`,
        [id, actorId, body.reason]
      );
      await invalidateDepositReviews(client, before, actorId, true);
      const deposit = await loadBankDeposit(client, id);
      await appendReviewEvent(client, {
        entity_type: "deposit",
        entity_id: id,
        action: "deposit_void",
        actor_id: actorId,
        details: { before, after: deposit, reason: body.reason },
      });
      return { deposit };
    }
  );
}
