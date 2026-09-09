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
import { movementContext, movementFacts, movementRow } from "./movement-read";
import { movementLine } from "./movement-rules";
import {
  movementBank,
  movementTransaction,
  normalizeDocumentReference,
} from "./movement-source";
import {
  movementPostSchema,
  movementPreviewSchema,
  movementReceivePreviewSchema,
  movementReceiveSchema,
  movementReverseSchema,
  movementSaveSchema,
  type MovementDocument,
  type MovementInput,
  type MovementPreview,
} from "./movement-types";
import {
  appendReviewEvent,
  reviewHash,
  runReviewCommand,
} from "./review-common";
import { reviewToday } from "./review-date";
import { BankingError } from "./security";
import { bankId } from "./store";

export async function saveMovement(
  actorId: string,
  key: string,
  input: MovementInput
): Promise<Awaited<ReturnType<typeof movementContext>>> {
  const body = movementSaveSchema.parse(input);
  body.allocations = body.allocations.map((l) => ({
    ...l,
    source_id:
      l.source_kind === "document"
        ? normalizeDocumentReference(l.source_id)
        : l.source_id,
  }));
  return runReviewCommand(
    {
      actorId,
      key,
      operation: "movement_save",
      entityId: body.id ?? "new",
      body,
    },
    async (client) => {
      const old = body.id ? await movementRow(client, body.id) : null;
      if ((old?.movement.revision ?? 0) !== body.expected_revision)
        throw new BankingError("BANKING_MOVEMENT_STALE", 409);
      if (
        old &&
        (await completionHistory(client, "movement", old.movement.id)).length
      )
        throw new BankingError("BANKING_MOVEMENT_IMMUTABLE", 409);
      const {
        id: ignoredId,
        expected_revision: ignoredRevision,
        ...payload
      } = body;
      void ignoredId;
      void ignoredRevision;
      const facts = await movementFacts(client, payload),
        id = body.id ?? bankId("bmv");
      if (!old) await completionCapacity(client, "bank_movement", 150);
      await client.query(
        `INSERT INTO bank_movement(id,revision,kind,reference,payload,source_snapshot,created_by)
      VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7) ON CONFLICT(id) DO UPDATE SET revision=EXCLUDED.revision,
      kind=EXCLUDED.kind,reference=EXCLUDED.reference,payload=EXCLUDED.payload,source_snapshot=EXCLUDED.source_snapshot,updated_at=now()`,
        [
          id,
          body.expected_revision + 1,
          body.kind,
          body.reference,
          JSON.stringify(payload),
          JSON.stringify(facts.snapshot),
          actorId,
        ]
      );
      await client.query(
        "DELETE FROM bank_movement_allocation WHERE movement_id=$1",
        [id]
      );
      for (const [index, allocation] of payload.allocations.entries()) {
        await completionCapacity(client, "bank_movement_allocation", 2000);
        await client.query(
          `INSERT INTO bank_movement_allocation(id,movement_id,sort_order,source_kind,source_id,amount_cents,capacity_cents,payload)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
          [
            bankId("bma"),
            id,
            index,
            allocation.source_kind,
            allocation.source_id,
            allocation.amount_cents,
            allocation.documented_capacity_cents,
            JSON.stringify(allocation),
          ]
        );
      }
      await appendReviewEvent(client, {
        entity_type: "movement",
        entity_id: id,
        actor_id: actorId,
        action: "movement_saved",
        details: { revision: body.expected_revision + 1 },
      });
      return movementContext(client, id);
    }
  );
}
async function buildPreview(
  client: PoolClient,
  id: string,
  revision: number,
  incoming?: { day: string; transaction_id: string | null }
): Promise<{
  movement: MovementDocument;
  facts: Awaited<ReturnType<typeof movementFacts>>;
  preview: MovementPreview;
}> {
  const { movement, source_snapshot } = await movementRow(client, id);
  if (movement.revision !== revision)
    throw new BankingError("BANKING_MOVEMENT_STALE", 409);
  const facts = await movementFacts(client, movement),
    history = await completionHistory(client, "movement", id);
  const stage = incoming ? "incoming" : "outgoing",
    day = incoming?.day ?? movement.day;
  if (
    history.some(
      (e) =>
        e.kind === "movement" && e.completion_stage === stage && !e.reversed_by
    )
  )
    facts.blockers.push("BANKING_ALREADY_POSTED");
  if (reviewHash(facts.snapshot) !== reviewHash(source_snapshot))
    facts.blockers.push("BANKING_MOVEMENT_SOURCE_STALE");
  if (day > reviewToday()) facts.blockers.push("BANKING_MOVEMENT_DATE_INVALID");
  if (incoming) {
    const out = history.find(
      (e) =>
        e.kind === "movement" &&
        e.completion_stage === "outgoing" &&
        !e.reversed_by
    );
    if (movement.kind !== "bank_transfer" || !out || day < out.day)
      throw new BankingError("BANKING_TRANSFER_OUTGOING_REQUIRED", 409);
    const bank = await movementBank(
      client,
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- an "outgoing" posting only exists for a bank_transfer that passed movementStructuralBlockers (requires destination_bank_account_id), and the movement document is immutable once any completion exists
      movement.destination_bank_account_id!,
      day
    );
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- only affects the type here; the `if (!transit ...)` check right below still handles the undefined case at runtime
    const transit = facts.accounts.find(
      (a) => a.id === movement.transit_account_list_id
    )!;
    if (!transit || transit.currency !== "USD")
      throw new BankingError("BANKING_TRANSFER_TRANSIT_REQUIRED", 409);
    facts.lines = [
      movementLine("bank", bank, movement.amount_cents, true),
      movementLine("transit", transit, movement.amount_cents, false),
    ];
    const source = {
      outgoing_id: out.id,
      outgoing_hash: out.source_hash,
      amount_cents: movement.amount_cents,
    };
    facts.claims = [
      {
        source_kind: "journal_funding",
        source_id: out.id,
        amount_cents: movement.amount_cents,
        capacity_cents: movement.amount_cents,
        source_hash: reviewHash(source),
        source_snapshot: source,
      },
    ];
    if (incoming.transaction_id)
      facts.claims.push(
        await movementTransaction(
          client,
          incoming.transaction_id,
          bank,
          day,
          -movement.amount_cents
        )
      );
  } else if (movement.kind === "bank_transfer") {
    const source = {
      movement_id: id,
      evidence: facts.snapshot.evidence,
      amount_cents: movement.amount_cents,
    };
    facts.claims.push({
      source_kind: "transfer_document",
      source_id: `${facts.bank.id}:${normalizeDocumentReference(movement.reference)}`,
      amount_cents: movement.amount_cents,
      capacity_cents: movement.amount_cents,
      source_hash: reviewHash(source),
      source_snapshot: source,
    });
    const documentary = {
      evidence: facts.snapshot.evidence,
      account_list_id: facts.bank.id,
      amount_cents: movement.amount_cents,
    };
    facts.claims.push({
      source_kind: "document_evidence",
      source_id: `${facts.snapshot.evidence.sha256}:${facts.bank.id}:transfer`,
      amount_cents: movement.amount_cents,
      capacity_cents: movement.amount_cents,
      source_hash: reviewHash(documentary),
      source_snapshot: documentary,
    });
  }
  await acquireBankAccountingPeriodLock(client, day);
  await assertBankAccountingPeriodOpen(client, day);
  if (!facts.blockers.length)
    await validateCompletionClaims(client, facts.claims);
  const sourceHash = reviewHash({
    movement,
    facts: facts.snapshot,
    claims: facts.claims,
    incoming: incoming
      ? { day: incoming.day, transaction_id: incoming.transaction_id }
      : null,
  });
  const preview: MovementPreview = {
    stage,
    day,
    amount_cents: movement.amount_cents,
    lines: facts.lines,
    source_hash: sourceHash,
    preview_hash: reviewHash({
      sourceHash,
      history: history.map((e) => e.id),
      lines: facts.lines,
    }),
    blockers: [...new Set(facts.blockers)],
    coverage: "partial",
  };
  return { movement, facts, preview };
}
export async function previewMovement(
  id: string,
  actorId: string,
  key: string,
  input: unknown,
  receive = false
): Promise<MovementPreview> {
  const incoming = receive
    ? movementReceivePreviewSchema.parse(input)
    : undefined;
  const body = incoming ?? movementPreviewSchema.parse(input);
  return runReviewCommand(
    {
      actorId,
      key,
      operation: receive ? "movement_receive_preview" : "movement_preview",
      entityId: id,
      body,
    },
    async (client) =>
      (await buildPreview(client, id, body.expected_revision, incoming)).preview
  );
}
export async function postMovement(
  id: string,
  actorId: string,
  key: string,
  input: unknown,
  receive = false
): Promise<Awaited<ReturnType<typeof movementContext>>> {
  const incoming = receive ? movementReceiveSchema.parse(input) : undefined;
  const body = incoming ?? movementPostSchema.parse(input);
  return runReviewCommand(
    {
      actorId,
      key,
      operation: receive ? "movement_receive" : "movement_post",
      entityId: id,
      body,
    },
    async (client) => {
      const built = await buildPreview(
        client,
        id,
        body.expected_revision,
        incoming
      );
      if (built.preview.blockers.length)
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- guarded by the `if (built.preview.blockers.length)` above, so index 0 always exists
        throw new BankingError(built.preview.blockers[0]!, 409);
      if (built.preview.preview_hash !== body.preview_hash)
        throw new BankingError("BANKING_MOVEMENT_PREVIEW_STALE", 409);
      const receipt = await client.query(
        `SELECT id FROM bank_review_event WHERE entity_type='command' AND entity_id=$1
      AND actor_id=$2 AND action=$3 AND result->>'preview_hash'=$4 LIMIT 1`,
        [
          id,
          actorId,
          receive ? "movement_receive_preview" : "movement_preview",
          body.preview_hash,
        ]
      );
      if (!receipt.rowCount)
        throw new BankingError("BANKING_MOVEMENT_PREVIEW_REQUIRED", 409);
      await postCompletionJournal(client, {
        kind: "movement",
        origin_id: id,
        stage: built.preview.stage,
        day: built.preview.day,
        actor_id: actorId,
        reference: built.movement.reference,
        description: built.movement.description,
        source_hash: built.preview.source_hash,
        source_snapshot: {
          source: { kind: "movement", id, name: built.movement.description },
          movement: built.movement,
          facts: built.facts.snapshot,
        },
        lines: built.preview.lines,
        claims: built.facts.claims,
        transaction_id: incoming
          ? incoming.transaction_id
          : built.movement.transaction_id,
      });
      return movementContext(client, id);
    }
  );
}
export async function reverseMovement(
  id: string,
  actorId: string,
  key: string,
  input: unknown
): Promise<Awaited<ReturnType<typeof movementContext>>> {
  const body = movementReverseSchema.parse(input);
  return runReviewCommand(
    { actorId, key, operation: "movement_reverse", entityId: id, body },
    async (client) => {
      if (body.day > reviewToday())
        throw new BankingError("BANKING_MOVEMENT_DATE_INVALID", 409);
      await reverseCompletionJournal(client, {
        kind: "movement",
        origin_id: id,
        actor_id: actorId,
        ...body,
      });
      return movementContext(client, id);
    }
  );
}
