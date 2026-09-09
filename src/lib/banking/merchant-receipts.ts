import type { PoolClient } from "pg";
import { z } from "zod";

import {
  acquireBankAccountingPeriodLock,
  assertBankAccountingPeriodOpen,
} from "../accounting/banking-period-lock";

import type { AccountingAccount } from "./accounting-types";
import { completionEvidence } from "./completion-evidence";
import {
  completionHistory,
  postCompletionJournal,
  reverseCompletionJournal,
  validateCompletionClaims,
} from "./completion-journal";
import { movementLine } from "./movement-rules";
import { movementAccounts } from "./movement-source";
import { movementReverseSchema } from "./movement-types";
import type {
  CompletionClaim,
  CompletionLine,
  CompletionPosting,
} from "./movement-types";
import { receiptRead } from "./receipts-setup";
import { paymentReceiptSource } from "./receipts-source";
import type { ReceiptEvidence } from "./receipts-source";
import { reviewHash, runReviewCommand } from "./review-common";
import { reviewToday } from "./review-date";
import { BankingError } from "./security";
import { merchantReceiptSchema } from "./settlement-types";

type MerchantReceiptInput = z.infer<typeof merchantReceiptSchema>;
type MerchantReceiptPreview = {
  body: MerchantReceiptInput;
  source: ReceiptEvidence;
  fact: {
    payment: unknown;
    account: AccountingAccount;
    ar: AccountingAccount;
    evidence: { sha256: string; version: number };
  };
  claims: CompletionClaim[];
  lines: CompletionLine[];
  source_hash: string;
  preview_hash: string;
  coverage: "partial";
};

export const readMerchantReceipt = (
  id: string
): Promise<
  Omit<ReceiptEvidence, "blockers"> & {
    blockers: string[];
    postings: CompletionPosting[];
    coverage: "partial";
  }
> =>
  receiptRead(async (client) => {
    const source = await paymentReceiptSource(client, id, "card");
    return {
      ...source,
      blockers: await merchantReceiptDrift(client, id),
      postings: await completionHistory(client, "merchant_receipt", id),
      coverage: "partial" as const,
    };
  });

export async function merchantReceiptDrift(
  client: PoolClient,
  id: string
): Promise<string[]> {
  const live = await paymentReceiptSource(client, id, "card"),
    blockers = [...live.blockers];
  const rows = (
    await client.query<{
      source_snapshot: {
        fact: { payment: unknown; account: { id: string }; ar: { id: string } };
      };
    }>(
      `SELECT source_snapshot FROM bank_journal_entry e WHERE e.kind='merchant_receipt' AND e.completion_id=$1
      AND NOT EXISTS(SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id=e.id)`,
      [id]
    )
  ).rows;
  for (const row of rows) {
    const fact = row.source_snapshot.fact;
    if (reviewHash(fact.payment) !== reviewHash(live.snapshot.payment))
      blockers.push("BANKING_RECEIPT_SOURCE_STALE");
    const accounts = await movementAccounts(
      client,
      [fact.account.id, fact.ar.id],
      true
    );
    if (
      accounts.length !== 2 ||
      reviewHash(accounts.find((a) => a.id === fact.account.id)) !==
        reviewHash(fact.account) ||
      reviewHash(accounts.find((a) => a.id === fact.ar.id)) !==
        reviewHash(fact.ar)
    )
      blockers.push("BANKING_RECEIPT_MAPPING_STALE");
  }
  return [...new Set(blockers)];
}

async function receiptPreview(
  client: PoolClient,
  input: unknown
): Promise<MerchantReceiptPreview> {
  const body = merchantReceiptSchema.parse(input);
  const source = await paymentReceiptSource(client, body.payment_id, "card");
  if (source.blockers.length)
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- guarded by `source.blockers.length` above
    throw new BankingError(source.blockers[0]!, 409);
  if (source.source_hash !== body.expected_source_hash)
    throw new BankingError("BANKING_RECEIPT_SOURCE_STALE", 409);
  if (body.day !== source.source.day || body.day > reviewToday())
    throw new BankingError("BANKING_RECEIPT_DATE_INVALID", 409);
  const evidence = await completionEvidence(client, body.evidence_id);
  const accounts = await movementAccounts(
    client,
    [body.clearing_account_list_id, body.ar_account_list_id],
    body.attested
  );
  const clearing = accounts.find((a) => a.id === body.clearing_account_list_id),
    ar = accounts.find((a) => a.id === body.ar_account_list_id);
  if (
    !clearing ||
    clearing.account_type !== "OtherCurrentAsset" ||
    clearing.currency !== "USD" ||
    !ar ||
    ar.account_type !== "AccountsReceivable" ||
    ar.currency !== "USD" ||
    ar.id === clearing.id
  )
    throw new BankingError("BANKING_RECEIPT_MAPPING_INVALID", 409);
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- amount_cents is only null when blockers include BANKING_RECEIPT_SOURCE_MISSING/AMOUNT_INVALID, already rejected above
  const cents = source.source.amount_cents!;
  const fact = {
    payment: source.snapshot.payment,
    account: clearing,
    ar,
    evidence: { sha256: evidence.sha256, version: evidence.version },
  };
  const claims: CompletionClaim[] = [
    {
      source_kind: "payment_recognition",
      source_id: body.payment_id,
      amount_cents: cents,
      capacity_cents: cents,
      source_hash: reviewHash(fact),
      source_snapshot: fact,
    },
  ];
  const lines = [
    movementLine("clearing", clearing, cents, true),
    movementLine("receivable", ar, cents, false),
  ];
  const history = await completionHistory(
    client,
    "merchant_receipt",
    body.payment_id
  );
  if (history.some((e) => e.kind === "merchant_receipt" && !e.reversed_by))
    throw new BankingError("BANKING_ALREADY_POSTED", 409);
  await acquireBankAccountingPeriodLock(client, body.day);
  await assertBankAccountingPeriodOpen(client, body.day);
  await validateCompletionClaims(client, claims);
  const sourceHash = reviewHash({ body, fact, lines, claims });
  return {
    body,
    source,
    fact,
    claims,
    lines,
    source_hash: sourceHash,
    preview_hash: reviewHash({ sourceHash, history: history.map((e) => e.id) }),
    coverage: "partial" as const,
  };
}

export async function previewMerchantReceipt(
  actorId: string,
  key: string,
  input: unknown
): Promise<{
  preview_hash: string;
  source_hash: string;
  lines: CompletionLine[];
  coverage: "partial";
}> {
  const body = merchantReceiptSchema.parse(input);
  return runReviewCommand(
    {
      actorId,
      key,
      operation: "merchant_receipt_preview",
      entityId: body.payment_id,
      body,
    },
    async (client) => {
      const result = await receiptPreview(client, body);
      return {
        preview_hash: result.preview_hash,
        source_hash: result.source_hash,
        lines: result.lines,
        coverage: result.coverage,
      };
    }
  );
}
export async function postMerchantReceipt(
  actorId: string,
  key: string,
  input: unknown
): Promise<{ postings: CompletionPosting[]; coverage: "partial" }> {
  const body = merchantReceiptSchema
    .extend({ preview_hash: z.string().regex(/^[a-f0-9]{64}$/) })
    .parse(input);
  return runReviewCommand(
    {
      actorId,
      key,
      operation: "merchant_receipt_post",
      entityId: body.payment_id,
      body,
    },
    async (client) => {
      const { preview_hash, ...request } = body,
        result = await receiptPreview(client, request);
      if (preview_hash !== result.preview_hash)
        throw new BankingError("BANKING_RECEIPT_PREVIEW_STALE", 409);
      const issued = await client.query(
        `SELECT id FROM bank_review_event WHERE entity_type='command' AND entity_id=$1
      AND actor_id=$2 AND action='merchant_receipt_preview' AND result->>'preview_hash'=$3 LIMIT 1`,
        [body.payment_id, actorId, preview_hash]
      );
      if (!issued.rowCount)
        throw new BankingError("BANKING_RECEIPT_PREVIEW_REQUIRED", 409);
      await postCompletionJournal(client, {
        kind: "merchant_receipt",
        origin_id: body.payment_id,
        stage: "recognize",
        day: body.day,
        actor_id: actorId,
        reference: result.source.source.reference || body.payment_id,
        description: result.source.source.name,
        source_hash: result.source_hash,
        source_snapshot: {
          source: {
            kind: "merchant_receipt",
            id: body.payment_id,
            name: result.source.source.name,
          },
          fact: result.fact,
          request,
        },
        lines: result.lines,
        claims: result.claims,
      });
      return {
        postings: await completionHistory(
          client,
          "merchant_receipt",
          body.payment_id
        ),
        coverage: "partial" as const,
      };
    }
  );
}
export async function reverseMerchantReceipt(
  id: string,
  actorId: string,
  key: string,
  input: unknown
): Promise<{ postings: CompletionPosting[]; coverage: "partial" }> {
  const body = movementReverseSchema.parse(input);
  return runReviewCommand(
    { actorId, key, operation: "merchant_receipt_reverse", entityId: id, body },
    async (client) => {
      if (body.day > reviewToday())
        throw new BankingError("BANKING_RECEIPT_DATE_INVALID", 409);
      await reverseCompletionJournal(client, {
        kind: "merchant_receipt",
        origin_id: id,
        actor_id: actorId,
        ...body,
      });
      return {
        postings: await completionHistory(client, "merchant_receipt", id),
        coverage: "partial" as const,
      };
    }
  );
}
