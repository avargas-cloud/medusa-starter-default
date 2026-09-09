import type { PoolClient } from "pg";

import {
  acquireBankAccountingPeriodLock,
  assertBankAccountingPeriodOpen,
} from "../accounting/banking-period-lock";

import { completionEvidence } from "./completion-evidence";
import {
  appendReviewEvent,
  reviewHash,
  runReviewCommand,
} from "./review-common";
import { BankingError } from "./security";
import { statementContext, statementSnapshot } from "./statement-read";
import {
  statementBank,
  statementDocumentBlockers,
  statementLineFacts,
  statementPredecessor,
  statementRow,
} from "./statement-source";
import type { StatementDocument } from "./statement-types";
import {
  statementCloseSchema,
  statementReopenSchema,
  statementRevisionSchema,
  statementSaveSchema,
} from "./statement-types";
import { bankId } from "./store";

export async function statementCapacity(
  client: PoolClient,
  table: "bank_statement" | "bank_statement_line" | "bank_statement_match",
  extra = 1
): Promise<void> {
  const cap = table === "bank_statement" ? 36 : 5000;
  const count = Number(
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- COUNT(*) always returns exactly one row
    (
      await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM ${table}`
      )
    ).rows[0]!.count
  );
  if (count + extra > cap)
    throw new BankingError("BANKING_SANDBOX_CAP_REACHED", 409);
}
export async function statementEditable(
  client: PoolClient,
  id: string,
  revision: number
): Promise<StatementDocument> {
  const row = await statementRow(client, id);
  if (row.revision !== revision)
    throw new BankingError("BANKING_STATEMENT_STALE", 409);
  if (row.status !== "draft")
    throw new BankingError("BANKING_STATEMENT_PERIOD_CLOSED", 409);
  return row;
}
async function statementPeriods(
  client: PoolClient,
  from: string,
  to: string
): Promise<void> {
  for (let month = from.slice(0, 7); month <= to.slice(0, 7); ) {
    const day = `${month}-01`;
    await acquireBankAccountingPeriodLock(client, day);
    await assertBankAccountingPeriodOpen(client, day);
    const date = new Date(`${day}T12:00:00Z`);
    date.setUTCMonth(date.getUTCMonth() + 1);
    month = date.toISOString().slice(0, 7);
  }
}
export async function saveStatement(
  actorId: string,
  key: string,
  input: unknown
): Promise<Awaited<ReturnType<typeof statementContext>>> {
  const body = statementSaveSchema.parse(input);
  const invalid = statementDocumentBlockers(body).find(
    (code) =>
      code === "BANKING_STATEMENT_DATE_INVALID" ||
      code === "BANKING_STATEMENT_DUPLICATE_LINE"
  );
  if (invalid) throw new BankingError(invalid, 409);
  return runReviewCommand(
    {
      actorId,
      key,
      operation: "statement_save",
      entityId: body.id ?? "new",
      body,
    },
    async (client) => {
      const old = body.id
        ? await statementEditable(client, body.id, body.expected_revision)
        : null;
      if (!old && body.expected_revision !== 0)
        throw new BankingError("BANKING_STATEMENT_STALE", 409);
      if (
        old &&
        (
          await client.query(
            "SELECT id FROM bank_statement_match WHERE statement_id=$1 AND deleted_at IS NULL LIMIT 1",
            [old.id]
          )
        ).rowCount
      )
        throw new BankingError("BANKING_STATEMENT_UNMATCH_FIRST", 409);
      const mapped = await statementBank(client, body.bank_account_id);
      await completionEvidence(client, body.evidence_id);
      const previous = await statementPredecessor(
        client,
        mapped.account.id,
        body.from,
        body.id ?? null
      );
      if (!old) await statementCapacity(client, "bank_statement");
      await statementCapacity(client, "bank_statement_line", body.lines.length);
      const {
        id: unusedId,
        expected_revision: unusedRevision,
        lines,
        ...payload
      } = body;
      void unusedId;
      void unusedRevision;
      const id = body.id ?? bankId("bst");
      await client.query(
        `INSERT INTO bank_statement(id,revision,status,bank_account_id,account_list_id,opening_id,predecessor_id,
      from_day,to_day,payload,evidence_id,created_by) VALUES($1,$2,'draft',$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)
      ON CONFLICT(id) DO UPDATE SET revision=EXCLUDED.revision,bank_account_id=EXCLUDED.bank_account_id,
      account_list_id=EXCLUDED.account_list_id,opening_id=EXCLUDED.opening_id,predecessor_id=EXCLUDED.predecessor_id,
      from_day=EXCLUDED.from_day,to_day=EXCLUDED.to_day,payload=EXCLUDED.payload,evidence_id=EXCLUDED.evidence_id,updated_at=now()`,
        [
          id,
          body.expected_revision + 1,
          body.bank_account_id,
          mapped.account.id,
          mapped.opening.id,
          previous?.id ?? null,
          body.from,
          body.to,
          JSON.stringify(payload),
          body.evidence_id,
          actorId,
        ]
      );
      await client.query(
        "UPDATE bank_statement_line SET deleted_at=now(),updated_at=now() WHERE statement_id=$1 AND deleted_at IS NULL",
        [id]
      );
      for (const line of lines) {
        const facts = await statementLineFacts(client, line, mapped.account.id);
        await client.query(
          `INSERT INTO bank_statement_line(id,statement_id,external_key,day,amount_cents,description,
        transaction_id,source_hash,source_snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
          [
            bankId("bsl"),
            id,
            line.external_key,
            line.day,
            line.amount_cents,
            line.description,
            line.transaction_id,
            facts.hash,
            JSON.stringify(facts.snapshot),
          ]
        );
      }
      await appendReviewEvent(client, {
        entity_type: "statement",
        entity_id: id,
        actor_id: actorId,
        action: "statement_saved",
        details: { previous: old, revision: body.expected_revision + 1 },
      });
      return statementContext(client, id);
    }
  );
}
async function closePreview(
  client: PoolClient,
  id: string,
  actorId: string,
  revision: number
): Promise<
  Awaited<ReturnType<typeof statementContext>> & { preview_hash: string }
> {
  await statementEditable(client, id, revision);
  const context = await statementContext(client, id);
  await statementPeriods(client, context.statement.from, context.statement.to);
  return {
    ...context,
    preview_hash: reviewHash({
      actorId,
      id,
      revision,
      source_hash: context.source_hash,
    }),
  };
}
export async function previewStatement(
  id: string,
  actorId: string,
  key: string,
  input: unknown
): Promise<Awaited<ReturnType<typeof closePreview>>> {
  const body = statementRevisionSchema.parse(input);
  return runReviewCommand(
    { actorId, key, operation: "statement_preview", entityId: id, body },
    (client) => closePreview(client, id, actorId, body.expected_revision)
  );
}
export async function closeStatement(
  id: string,
  actorId: string,
  key: string,
  input: unknown
): Promise<Awaited<ReturnType<typeof statementContext>>> {
  const body = statementCloseSchema.parse(input);
  return runReviewCommand(
    { actorId, key, operation: "statement_close", entityId: id, body },
    async (client) => {
      const context = await closePreview(
        client,
        id,
        actorId,
        body.expected_revision
      );
      if (context.blockers.length)
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- guarded by context.blockers.length above
        throw new BankingError(context.blockers[0]!, 409);
      if (context.preview_hash !== body.preview_hash)
        throw new BankingError("BANKING_STATEMENT_PREVIEW_STALE", 409);
      const issued = await client.query(
        `SELECT id FROM bank_review_event WHERE entity_type='command' AND entity_id=$1
      AND actor_id=$2 AND action='statement_preview' AND result->>'preview_hash'=$3 LIMIT 1`,
        [id, actorId, body.preview_hash]
      );
      if (!issued.rowCount)
        throw new BankingError("BANKING_STATEMENT_PREVIEW_REQUIRED", 409);
      const evidence = await completionEvidence(
          client,
          context.statement.evidence_id
        ),
        snapshot = statementSnapshot(context, evidence.sha256);
      await client.query(
        `UPDATE bank_statement SET status='closed',revision=revision+1,closed_by=$2,closed_at=now(),
      input_hash=$3,closed_snapshot=$4::jsonb,updated_at=now() WHERE id=$1`,
        [id, actorId, context.source_hash, JSON.stringify(snapshot)]
      );
      await appendReviewEvent(client, {
        entity_type: "statement",
        entity_id: id,
        actor_id: actorId,
        action: "statement_closed",
        details: { snapshot, source_hash: context.source_hash, zero_gl: true },
      });
      return statementContext(client, id);
    }
  );
}
export async function reopenStatement(
  id: string,
  actorId: string,
  key: string,
  input: unknown
): Promise<Awaited<ReturnType<typeof statementContext>>> {
  const body = statementReopenSchema.parse(input);
  return runReviewCommand(
    { actorId, key, operation: "statement_reopen", entityId: id, body },
    async (client) => {
      const old = await statementRow(client, id);
      if (old.status !== "closed" || old.revision !== body.expected_revision)
        throw new BankingError("BANKING_STATEMENT_STALE", 409);
      await statementPeriods(client, old.from, old.to);
      const history = [
        ...old.history,
        {
          actor_id: actorId,
          reason: body.reason,
          closed_snapshot: old.closed_snapshot,
          input_hash: old.input_hash,
          closed_at: old.closed_at,
          closed_by: old.closed_by,
        },
      ];
      await client.query(
        "UPDATE bank_statement SET status='draft',revision=revision+1,history=$2::jsonb,updated_at=now() WHERE id=$1",
        [id, JSON.stringify(history)]
      );
      await appendReviewEvent(client, {
        entity_type: "statement",
        entity_id: id,
        actor_id: actorId,
        action: "statement_reopened",
        details: {
          reason: body.reason,
          previous_snapshot: old.closed_snapshot,
          zero_gl: true,
        },
      });
      return statementContext(client, id);
    }
  );
}
