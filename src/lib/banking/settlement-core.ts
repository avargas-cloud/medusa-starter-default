import type { PoolClient } from "pg";

import {
  acquireBankAccountingPeriodLock,
  assertBankAccountingPeriodOpen,
} from "../accounting/banking-period-lock";

import { completionCapacity } from "./completion-evidence";
import {
  completionHistory,
  postCompletionJournal,
  reverseCompletionJournal,
  validateCompletionClaims,
} from "./completion-journal";
import { normalizeDocumentReference } from "./movement-source";
import {
  movementPostSchema,
  movementPreviewSchema,
  movementReverseSchema,
} from "./movement-types";
import {
  appendReviewEvent,
  reviewHash,
  runReviewCommand,
} from "./review-common";
import { reviewToday } from "./review-date";
import { BankingError } from "./security";
import {
  settlementContext,
  settlementFacts,
  settlementRow,
} from "./settlement-read";
import {
  settlementSaveSchema,
  type SettlementInput,
  type SettlementPreview,
} from "./settlement-types";
import { bankId } from "./store";

export async function saveSettlement(
  actorId: string,
  key: string,
  input: SettlementInput
): ReturnType<typeof settlementContext> {
  const body = settlementSaveSchema.parse(input);
  body.processor = normalizeDocumentReference(body.processor);
  body.merchant = normalizeDocumentReference(body.merchant);
  body.reference = normalizeDocumentReference(body.reference);
  body.lines = body.lines.map((l) => ({
    ...l,
    source_id: ["fee", "chargeback", "reserve_hold"].includes(l.kind)
      ? normalizeDocumentReference(l.source_id)
      : l.source_id,
  }));
  return runReviewCommand(
    {
      actorId,
      key,
      operation: "settlement_save",
      entityId: body.id ?? "new",
      body,
    },
    async (client) => {
      const old = body.id ? await settlementRow(client, body.id) : null;
      if ((old?.settlement.revision ?? 0) !== body.expected_revision)
        throw new BankingError("BANKING_SETTLEMENT_STALE", 409);
      if (
        old &&
        (
          await completionHistory(
            client,
            "merchant_settlement",
            old.settlement.id
          )
        ).length
      )
        throw new BankingError("BANKING_SETTLEMENT_IMMUTABLE", 409);
      const {
        id: ignoredId,
        expected_revision: ignoredRevision,
        ...payload
      } = body;
      void ignoredId;
      void ignoredRevision;
      const duplicate = await client.query(
        `SELECT id FROM bank_merchant_settlement WHERE lower(trim(processor))=$1
      AND lower(trim(merchant))=$2 AND lower(trim(reference))=$3 AND currency='USD' AND id IS DISTINCT FROM $4::text`,
        [body.processor, body.merchant, body.reference, body.id ?? null]
      );
      if (duplicate.rowCount)
        throw new BankingError("BANKING_SETTLEMENT_DUPLICATE", 409);
      const facts = await settlementFacts(client, payload),
        id = body.id ?? bankId("bms");
      if (!old)
        await completionCapacity(client, "bank_merchant_settlement", 100);
      await client.query(
        `INSERT INTO bank_merchant_settlement(id,revision,processor,merchant,reference,currency,payload,source_snapshot,created_by)
      VALUES($1,$2,$3,$4,$5,'USD',$6::jsonb,$7::jsonb,$8) ON CONFLICT(id) DO UPDATE SET revision=EXCLUDED.revision,
      processor=EXCLUDED.processor,merchant=EXCLUDED.merchant,reference=EXCLUDED.reference,payload=EXCLUDED.payload,
      source_snapshot=EXCLUDED.source_snapshot,updated_at=now()`,
        [
          id,
          body.expected_revision + 1,
          body.processor,
          body.merchant,
          body.reference,
          JSON.stringify(payload),
          JSON.stringify(facts.snapshot),
          actorId,
        ]
      );
      await client.query(
        "DELETE FROM bank_merchant_settlement_line WHERE settlement_id=$1",
        [id]
      );
      for (const [index, line] of payload.lines.entries()) {
        await completionCapacity(client, "bank_merchant_settlement_line", 2000);
        await client.query(
          `INSERT INTO bank_merchant_settlement_line(id,settlement_id,sort_order,kind,source_id,amount_cents,payload)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,
          [
            bankId("bml"),
            id,
            index,
            line.kind,
            line.source_id,
            line.amount_cents,
            JSON.stringify(line),
          ]
        );
      }
      await appendReviewEvent(client, {
        entity_type: "settlement",
        entity_id: id,
        actor_id: actorId,
        action: "settlement_saved",
        details: { revision: body.expected_revision + 1 },
      });
      return settlementContext(client, id);
    }
  );
}
async function buildPreview(
  client: PoolClient,
  id: string,
  revision: number
): Promise<{
  settlement: Awaited<ReturnType<typeof settlementRow>>["settlement"];
  facts: Awaited<ReturnType<typeof settlementFacts>>;
  preview: SettlementPreview;
}> {
  const { settlement, source_snapshot } = await settlementRow(client, id);
  if (settlement.revision !== revision)
    throw new BankingError("BANKING_SETTLEMENT_STALE", 409);
  const facts = await settlementFacts(client, settlement),
    history = await completionHistory(client, "merchant_settlement", id);
  if (history.some((e) => e.kind === "merchant_settlement" && !e.reversed_by))
    facts.blockers.push("BANKING_ALREADY_POSTED");
  if (reviewHash(facts.snapshot) !== reviewHash(source_snapshot))
    facts.blockers.push("BANKING_SETTLEMENT_SOURCE_STALE");
  await acquireBankAccountingPeriodLock(client, settlement.day);
  await assertBankAccountingPeriodOpen(client, settlement.day);
  if (!facts.blockers.length)
    await validateCompletionClaims(client, facts.claims);
  const sourceHash = reviewHash({
    settlement,
    facts: facts.snapshot,
    claims: facts.claims,
  });
  const preview: SettlementPreview = {
    preview_hash: reviewHash({
      sourceHash,
      history: history.map((e) => e.id),
      lines: facts.lines,
    }),
    source_hash: sourceHash,
    lines: facts.lines,
    totals: facts.totals,
    blockers: [...new Set(facts.blockers)],
    coverage: "partial",
  };
  return { settlement, facts, preview };
}
export async function previewSettlement(
  id: string,
  actorId: string,
  key: string,
  input: unknown
): Promise<SettlementPreview> {
  const body = movementPreviewSchema.parse(input);
  return runReviewCommand(
    { actorId, key, operation: "settlement_preview", entityId: id, body },
    async (client) =>
      (await buildPreview(client, id, body.expected_revision)).preview
  );
}
export async function postSettlement(
  id: string,
  actorId: string,
  key: string,
  input: unknown
): ReturnType<typeof settlementContext> {
  const body = movementPostSchema.parse(input);
  return runReviewCommand(
    { actorId, key, operation: "settlement_post", entityId: id, body },
    async (client) => {
      const built = await buildPreview(client, id, body.expected_revision);
      if (built.preview.blockers.length)
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- el `if (built.preview.blockers.length)` de arriba garantiza que el índice 0 existe
        throw new BankingError(built.preview.blockers[0]!, 409);
      if (built.preview.preview_hash !== body.preview_hash)
        throw new BankingError("BANKING_SETTLEMENT_PREVIEW_STALE", 409);
      const issued = await client.query(
        `SELECT id FROM bank_review_event WHERE entity_type='command' AND entity_id=$1 AND actor_id=$2
      AND action='settlement_preview' AND result->>'preview_hash'=$3 LIMIT 1`,
        [id, actorId, body.preview_hash]
      );
      if (!issued.rowCount)
        throw new BankingError("BANKING_SETTLEMENT_PREVIEW_REQUIRED", 409);
      await postCompletionJournal(client, {
        kind: "merchant_settlement",
        origin_id: id,
        stage: "settle",
        day: built.settlement.day,
        actor_id: actorId,
        reference: built.settlement.reference,
        description:
          built.settlement.memo || `${built.settlement.processor} settlement`,
        source_hash: built.preview.source_hash,
        source_snapshot: {
          source: {
            kind: "merchant_settlement",
            id,
            name: built.settlement.merchant,
          },
          settlement: built.settlement,
          facts: built.facts.snapshot,
        },
        lines: built.preview.lines,
        claims: built.facts.claims,
        transaction_id: built.settlement.transaction_id,
      });
      return settlementContext(client, id);
    }
  );
}
export async function reverseSettlement(
  id: string,
  actorId: string,
  key: string,
  input: unknown
): ReturnType<typeof settlementContext> {
  const body = movementReverseSchema.parse(input);
  return runReviewCommand(
    { actorId, key, operation: "settlement_reverse", entityId: id, body },
    async (client) => {
      if (body.day > reviewToday())
        throw new BankingError("BANKING_SETTLEMENT_DATE_INVALID", 409);
      await reverseCompletionJournal(client, {
        kind: "merchant_settlement",
        origin_id: id,
        actor_id: actorId,
        ...body,
      });
      return settlementContext(client, id);
    }
  );
}
