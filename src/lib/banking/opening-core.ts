import type { z } from "zod";

import { openingPaymentSnapshot } from "./opening-funding";
import { openingContext, openingMapping, openingRow } from "./opening-read";
import {
  openingAdoptSchema,
  openingPreviewSchema,
  openingRevokeSchema,
  openingSaveSchema,
  type OpeningContext,
  type OpeningPreview,
  type OpeningSaveInput,
} from "./opening-types";
import {
  openingPeriod,
  openingPreview,
  validateOpening,
} from "./opening-validation";
import { receiptRead } from "./receipts-setup";
import { reviewCapacity, reviewHash, runReviewCommand } from "./review-common";
import { BankingError } from "./security";
import { bankId } from "./store";

export async function saveOpening(
  actorId: string,
  key: string,
  input: OpeningSaveInput
): Promise<OpeningContext> {
  const body = openingSaveSchema.parse(input);
  return runReviewCommand(
    {
      actorId,
      key,
      operation: "opening_save",
      entityId: body.id ?? "new",
      body,
    },
    async (client) => {
      const old = body.id ? await openingRow(client, body.id) : null;
      if ((old?.revision ?? 0) !== body.expected_revision)
        throw new BankingError("BANKING_OPENING_STALE", 409);
      if (old && old.status !== "draft")
        throw new BankingError("BANKING_OPENING_DRAFT_REQUIRED", 409);
      const { setup, account } = await openingMapping(
        client,
        body.kind,
        body.bank_account_id ?? null
      );
      if (body.kind === "clearing" && body.statement_balance_cents !== null)
        throw new BankingError("BANKING_OPENING_ITEM_INVALID", 409);
      const id = old?.id ?? bankId("bob");
      if (!old) await reviewCapacity(client, "bank_opening_balance", 20);
      const keys = body.items.map((item) =>
        item.external_key.trim().toLowerCase()
      );
      const payments = body.items.flatMap((item) =>
        item.payment_id ? [item.payment_id] : []
      );
      if (
        new Set(keys).size !== keys.length ||
        new Set(payments).size !== payments.length
      )
        throw new BankingError("BANKING_OPENING_DUPLICATE_SOURCE", 409);
      const stored = [];
      for (const item of body.items) {
        if (
          item.original_day >= setup.cut_date ||
          (body.kind === "clearing") !== (item.kind === "uf_receipt")
        )
          throw new BankingError("BANKING_OPENING_ITEM_INVALID", 409);
        const payment = item.payment_id
          ? await openingPaymentSnapshot(
              client,
              item.payment_id,
              setup.cut_date
            )
          : null;
        if (payment?.blockers.length)
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- el `if (payment?.blockers.length)` de arriba garantiza al menos un elemento
          throw new BankingError(payment.blockers[0]!, 409);
        if (
          payment &&
          (payment.amount_cents === null ||
            item.amount_cents > payment.amount_cents)
        )
          throw new BankingError("BANKING_OPENING_AMOUNT_INVALID", 409);
        const source = {
          ...item,
          id: undefined,
          external_key: item.external_key.trim().toLowerCase(),
          ...(payment?.snapshot ?? {}),
          verified_outstanding_cents: item.amount_cents,
        };
        stored.push({ item, snapshot: source, hash: reviewHash(source) });
      }
      await client.query(
        `INSERT INTO bank_opening_balance(id,revision,kind,status,setup_id,cut_date,bank_account_id,
      account_list_id,currency,account_snapshot,book_balance_cents,statement_balance_cents,statement_evidence_id,books_evidence_id,reference)
      VALUES($1,$2,$3,'draft',$4,$5,$6,$7,'USD',$8::jsonb,$9,$10,$11,$12,$13)
      ON CONFLICT(id) DO UPDATE SET revision=EXCLUDED.revision,kind=EXCLUDED.kind,setup_id=EXCLUDED.setup_id,cut_date=EXCLUDED.cut_date,
        bank_account_id=EXCLUDED.bank_account_id,account_list_id=EXCLUDED.account_list_id,account_snapshot=EXCLUDED.account_snapshot,
        book_balance_cents=EXCLUDED.book_balance_cents,statement_balance_cents=EXCLUDED.statement_balance_cents,
        statement_evidence_id=EXCLUDED.statement_evidence_id,books_evidence_id=EXCLUDED.books_evidence_id,reference=EXCLUDED.reference,updated_at=now()`,
        [
          id,
          body.expected_revision + 1,
          body.kind,
          setup.id,
          setup.cut_date,
          body.bank_account_id ?? null,
          account.id,
          JSON.stringify(account),
          body.book_balance_cents,
          body.statement_balance_cents,
          body.statement_evidence_id ?? null,
          body.books_evidence_id ?? null,
          body.reference,
        ]
      );
      await client.query("DELETE FROM bank_opening_item WHERE opening_id=$1", [
        id,
      ]);
      for (const { item, snapshot, hash } of stored) {
        await reviewCapacity(client, "bank_opening_item", 2000);
        await client.query(
          `INSERT INTO bank_opening_item(id,opening_id,kind,original_day,amount_cents,external_key,reference,description,
        payment_id,evidence_id,source_snapshot,source_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)`,
          [
            bankId("boi"),
            id,
            item.kind,
            item.original_day,
            item.amount_cents,
            item.external_key.trim().toLowerCase(),
            item.reference,
            item.description,
            item.payment_id ?? null,
            item.evidence_id ?? null,
            JSON.stringify(snapshot),
            hash,
          ]
        );
      }
      return openingContext(client, id);
    }
  );
}
export function previewOpening(
  id: string,
  input: z.infer<typeof openingPreviewSchema>
): Promise<OpeningPreview> {
  const body = openingPreviewSchema.parse(input);
  return receiptRead(async (client) =>
    openingPreview(await validateOpening(client, id, body.expected_revision))
  );
}
export async function adoptOpening(
  id: string,
  actorId: string,
  key: string,
  input: z.infer<typeof openingAdoptSchema>
): Promise<OpeningContext> {
  const body = openingAdoptSchema.parse(input);
  return runReviewCommand(
    { actorId, key, operation: "opening_adopt", entityId: id, body },
    async (client) => {
      const context = await validateOpening(client, id, body.expected_revision);
      if (openingPreview(context).preview_hash !== body.preview_hash)
        throw new BankingError("BANKING_OPENING_PREVIEW_STALE", 409);
      await client.query(
        `UPDATE bank_opening_balance SET status='adopted',revision=revision+1,adopted_by=$2,adopted_at=now(),updated_at=now() WHERE id=$1`,
        [id, actorId]
      );
      return openingContext(client, id);
    }
  );
}
export async function revokeOpening(
  id: string,
  actorId: string,
  key: string,
  input: z.infer<typeof openingRevokeSchema>
): Promise<OpeningContext> {
  const body = openingRevokeSchema.parse(input);
  return runReviewCommand(
    { actorId, key, operation: "opening_revoke", entityId: id, body },
    async (client) => {
      const opening = await openingRow(client, id);
      if (opening.revision !== body.expected_revision)
        throw new BankingError("BANKING_OPENING_STALE", 409);
      if (opening.status !== "adopted")
        throw new BankingError("BANKING_OPENING_NOT_ADOPTED", 409);
      await openingPeriod(client, opening.cut_date);
      const dependencies = await client.query(
        `SELECT 1 FROM bank_journal_line line JOIN bank_journal_entry entry ON entry.id=line.entry_id
      WHERE line.account_list_id=$1 AND entry.day>=$2 LIMIT 1`,
        [opening.account_list_id, opening.cut_date]
      );
      if (dependencies.rowCount)
        throw new BankingError("BANKING_OPENING_DEPENDENCIES", 409);
      await client.query(
        `UPDATE bank_opening_balance SET status='revoked',revision=revision+1,revoked_by=$2,revoked_at=now(),
      revoke_reason=$3,updated_at=now() WHERE id=$1`,
        [id, actorId, body.reason]
      );
      return openingContext(client, id);
    }
  );
}
