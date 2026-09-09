import type { PoolClient } from "pg";

import {
  acquireBankAccountingPeriodLock,
  assertBankAccountingPeriodOpen,
} from "../accounting/banking-period-lock";

import {
  expenseCandidates,
  validateExpenseResolutions,
} from "./accounting-candidates";
import { accountingContext } from "./accounting-read";
import { accountingSource } from "./accounting-source";
import {
  accountingDraftSchema,
  accountingPostSchema,
  accountingPreviewSchema,
  accountingReverseSchema,
  expenseLines,
  type DraftInput,
  type ExpenseDraft,
  type JournalLine,
} from "./accounting-types";
import {
  appendReviewEvent,
  reviewCapacity,
  reviewHash,
  runReviewCommand,
} from "./review-common";
import { reviewToday } from "./review-date";
import { BankingError } from "./security";
import { bankId } from "./store";

async function currentExpense(
  client: PoolClient,
  id: string
): Promise<{
  draft: ExpenseDraft | undefined;
  live: { id: string } | undefined;
}> {
  const draft = (
    await client.query<ExpenseDraft>(
      `SELECT id,transaction_id,revision,nature,reference,description,
    attested,dismissals,source_hash FROM bank_direct_expense WHERE transaction_id=$1 AND deleted_at IS NULL FOR UPDATE`,
      [id]
    )
  ).rows[0];
  const live = (
    await client.query<{ id: string }>(
      `SELECT e.id FROM bank_journal_entry e WHERE e.transaction_id=$1
    AND e.kind='expense' AND NOT EXISTS(SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id=e.id)`,
      [id]
    )
  ).rows[0];
  return { draft, live };
}

export async function saveAccountingDraft(
  id: string,
  actorId: string,
  key: string,
  input: DraftInput
): Promise<Awaited<ReturnType<typeof accountingContext>>> {
  const body = accountingDraftSchema.parse(input);
  return runReviewCommand(
    { actorId, key, operation: "accounting_draft", entityId: id, body },
    async (client) => {
      const context = await accountingSource(client, id);
      if (context.blockers.length)
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- el `if (context.blockers.length)` de arriba garantiza al menos un elemento
        throw new BankingError(context.blockers[0]!, 409);
      if (context.source_hash !== body.source_hash)
        throw new BankingError("BANKING_EXPENSE_SOURCE_STALE", 409);
      const { draft, live } = await currentExpense(client, id);
      if (live) throw new BankingError("BANKING_ALREADY_POSTED", 409);
      if ((draft?.revision ?? 0) !== body.expected_revision)
        throw new BankingError("BANKING_EXPENSE_VERSION_CONFLICT", 409);
      const candidates = await expenseCandidates(
        client,
        context,
        body.reference
      );
      const next = {
        ...body,
        id: draft?.id ?? bankId("bexp"),
        transaction_id: id,
        revision: (draft?.revision ?? 0) + 1,
      };
      // Drafts may retain unresolved candidates; only preview/post recognize money.
      // This also lets a newly entered reference reveal candidates before the operator resolves them.
      if (!draft) await reviewCapacity(client, "bank_direct_expense", 200);
      await client.query(
        `INSERT INTO bank_direct_expense
      (id,transaction_id,revision,nature,reference,description,attested,dismissals,source_hash,created_by,updated_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$10)
      ON CONFLICT(transaction_id) DO UPDATE SET revision=EXCLUDED.revision,nature=EXCLUDED.nature,
      reference=EXCLUDED.reference,description=EXCLUDED.description,attested=EXCLUDED.attested,
      dismissals=EXCLUDED.dismissals,source_hash=EXCLUDED.source_hash,updated_by=EXCLUDED.updated_by,updated_at=now()`,
        [
          next.id,
          id,
          next.revision,
          body.nature,
          body.reference,
          body.description,
          body.attested,
          JSON.stringify(body.dismissals),
          body.source_hash,
          actorId,
        ]
      );
      await appendReviewEvent(client, {
        entity_type: "expense",
        entity_id: next.id,
        transaction_id: id,
        action: "expense_draft_saved",
        actor_id: actorId,
        details: { before: draft ?? null, after: next, candidates },
      });
      return accountingContext(client, id);
    }
  );
}

async function buildPreview(
  client: PoolClient,
  id: string,
  expectedRevision: number
): Promise<{
  context: Awaited<ReturnType<typeof accountingSource>>;
  draft: ExpenseDraft;
  preview: {
    day: string;
    amount_cents: number | null;
    lines: JournalLine[];
    preview_hash: string;
    blockers: string[];
  };
  candidates: Awaited<ReturnType<typeof expenseCandidates>>;
}> {
  const context = await accountingSource(client, id);
  if (context.blockers.length)
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- el `if (context.blockers.length)` de arriba garantiza al menos un elemento
    throw new BankingError(context.blockers[0]!, 409);
  const { draft, live } = await currentExpense(client, id);
  if (live) throw new BankingError("BANKING_ALREADY_POSTED", 409);
  if (!draft || draft.revision !== expectedRevision)
    throw new BankingError("BANKING_EXPENSE_VERSION_CONFLICT", 409);
  if (draft.source_hash !== context.source_hash)
    throw new BankingError("BANKING_EXPENSE_SOURCE_STALE", 409);
  const candidates = await expenseCandidates(client, context, draft.reference);
  validateExpenseResolutions(draft, candidates);
  // runReviewCommand already acquired banking-review; no caller acquires the locks in reverse order.
  await acquireBankAccountingPeriodLock(client, context.source.day);
  await assertBankAccountingPeriodOpen(client, context.source.day);
  const lines = expenseLines(context.source);
  const preview = {
    day: context.source.day,
    amount_cents: context.source.amount_cents,
    lines,
    preview_hash: reviewHash({
      draft,
      source_hash: context.source_hash,
      candidates,
      lines,
    }),
    blockers: [] as string[],
  };
  return { context, draft, preview, candidates };
}

export async function previewAccountingExpense(
  id: string,
  actorId: string,
  key: string,
  input: { expected_revision: number }
): Promise<Awaited<ReturnType<typeof buildPreview>>["preview"]> {
  const body = accountingPreviewSchema.parse(input);
  return runReviewCommand(
    { actorId, key, operation: "accounting_preview", entityId: id, body },
    async (client) => {
      const { preview } = await buildPreview(
        client,
        id,
        body.expected_revision
      );
      return preview;
    }
  );
}

async function insertLines(
  client: PoolClient,
  entryId: string,
  lines: JournalLine[]
): Promise<void> {
  for (const line of lines) {
    await reviewCapacity(client, "bank_journal_line", 2000);
    await client.query(
      `INSERT INTO bank_journal_line
      (id,entry_id,role,account_list_id,account_snapshot,debit_cents,credit_cents) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7)`,
      [
        bankId("bjl"),
        entryId,
        line.role,
        line.account_list_id,
        JSON.stringify(line.account_snapshot),
        line.debit_cents,
        line.credit_cents,
      ]
    );
  }
}

export async function postAccountingExpense(
  id: string,
  actorId: string,
  key: string,
  input: { expected_revision: number; preview_hash: string }
): Promise<Awaited<ReturnType<typeof accountingContext>>> {
  const body = accountingPostSchema.parse(input);
  return runReviewCommand(
    { actorId, key, operation: "accounting_post", entityId: id, body },
    async (client) => {
      const { context, draft, preview, candidates } = await buildPreview(
        client,
        id,
        body.expected_revision
      );
      if (preview.preview_hash !== body.preview_hash)
        throw new BankingError("BANKING_EXPENSE_PREVIEW_STALE", 409);
      // Preview is an explicit prior action, not a hash an API caller may invent to skip the review step.
      const receipt = await client.query(
        `SELECT id FROM bank_review_event WHERE entity_type='command'
      AND entity_id=$1 AND action='accounting_preview' AND actor_id=$2 AND result->>'preview_hash'=$3 LIMIT 1`,
        [id, actorId, body.preview_hash]
      );
      if (!receipt.rowCount)
        throw new BankingError("BANKING_EXPENSE_PREVIEW_REQUIRED", 409);
      await reviewCapacity(client, "bank_journal_entry", 500);
      const entryId = bankId("bje");
      await client.query(
        `INSERT INTO bank_journal_entry
      (id,expense_id,transaction_id,kind,day,currency,amount_cents,source_hash,source_snapshot,reference,description,actor_id)
      VALUES($1,$2,$3,'expense',$4,'USD',$5,$6,$7::jsonb,$8,$9,$10)`,
        [
          entryId,
          draft.id,
          id,
          preview.day,
          preview.amount_cents,
          context.source_hash,
          JSON.stringify({
            ...(context.snapshot as Record<string, unknown>),
            draft,
            candidates,
          }),
          draft.reference,
          draft.description,
          actorId,
        ]
      );
      await insertLines(client, entryId, preview.lines);
      await appendReviewEvent(client, {
        entity_type: "expense",
        entity_id: draft.id,
        transaction_id: id,
        action: "expense_posted",
        actor_id: actorId,
        details: { entry_id: entryId, preview_hash: preview.preview_hash },
      });
      return accountingContext(client, id);
    }
  );
}

export async function reverseAccountingExpense(
  id: string,
  actorId: string,
  key: string,
  input: { posting_id: string; day: string; reason: string }
): Promise<Awaited<ReturnType<typeof accountingContext>>> {
  const body = accountingReverseSchema.parse(input);
  return runReviewCommand(
    { actorId, key, operation: "accounting_reverse", entityId: id, body },
    async (client) => {
      const { draft, live } = await currentExpense(client, id);
      if (!draft || live?.id !== body.posting_id)
        throw new BankingError("BANKING_EXPENSE_POSTING_NOT_ACTIVE", 409);
      const originalResult = await client.query<{
        day: string;
        amount_cents: string;
        source_hash: string;
        source_snapshot: unknown;
        reference: string;
        description: string;
      }>("SELECT * FROM bank_journal_entry WHERE id=$1", [live.id]);
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- live.id vino de currentExpense() leyendo esa misma tabla en esta misma transacción; la fila existe
      const original = originalResult.rows[0]!;
      if (body.day < original.day || body.day > reviewToday())
        throw new BankingError("BANKING_EXPENSE_REVERSAL_DATE_INVALID", 409);
      await acquireBankAccountingPeriodLock(client, body.day);
      await assertBankAccountingPeriodOpen(client, body.day);
      const lines = (
        await client.query<JournalLine>(
          `SELECT role,account_list_id,account_snapshot,
      credit_cents::float8 AS debit_cents,debit_cents::float8 AS credit_cents FROM bank_journal_line WHERE entry_id=$1 ORDER BY role`,
          [live.id]
        )
      ).rows;
      await reviewCapacity(client, "bank_journal_entry", 500);
      const entryId = bankId("bje");
      await client.query(
        `INSERT INTO bank_journal_entry
      (id,expense_id,transaction_id,kind,day,currency,amount_cents,source_hash,source_snapshot,reference,description,actor_id,reverses_entry_id,reason)
      VALUES($1,$2,$3,'reversal',$4,'USD',$5,$6,$7::jsonb,$8,$9,$10,$11,$12)`,
        [
          entryId,
          draft.id,
          id,
          body.day,
          original.amount_cents,
          original.source_hash,
          JSON.stringify(original.source_snapshot),
          original.reference,
          original.description,
          actorId,
          live.id,
          body.reason,
        ]
      );
      await insertLines(client, entryId, lines);
      // Retire every pre-reversal preview. Reposting needs a new revision and explicit preview.
      await client.query(
        `UPDATE bank_direct_expense SET revision=revision+1,updated_by=$2,updated_at=now()
      WHERE id=$1`,
        [draft.id, actorId]
      );
      await appendReviewEvent(client, {
        entity_type: "expense",
        entity_id: draft.id,
        transaction_id: id,
        action: "expense_reversed",
        actor_id: actorId,
        details: {
          entry_id: entryId,
          reverses_entry_id: live.id,
          reason: body.reason,
          day: body.day,
        },
      });
      return accountingContext(client, id);
    }
  );
}
