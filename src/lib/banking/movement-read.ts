import type { PoolClient } from "pg";
import { receiptRead } from "./receipts-setup";
import { BankingError } from "./security";
import { reviewHash } from "./review-common";
import { reviewToday } from "./review-date";
import { completionEvidence } from "./completion-evidence";
import { completionHistory } from "./completion-journal";
import { movementAllocationFact, movementAccounts, movementBank, movementTransaction } from "./movement-source";
import { buildMovementLines, movementLine, movementStructuralBlockers } from "./movement-rules";
import type { CompletionClaim, CompletionLine, MovementContext, MovementDocument, MovementInput } from "./movement-types";

export async function movementRow(client: PoolClient, id: string) {
  const row = (await client.query<{ id: string; revision: number; payload: Omit<MovementInput, "id" | "expected_revision">;
    source_snapshot: unknown; created_by: string; created_at: string }>("SELECT * FROM bank_movement WHERE id=$1 AND deleted_at IS NULL FOR SHARE", [id])).rows[0];
  if (!row) throw new BankingError("BANKING_MOVEMENT_NOT_FOUND", 404);
  return { movement: { ...row.payload, id: row.id, revision: row.revision, created_by: row.created_by, created_at: row.created_at } as MovementDocument,
    source_snapshot: row.source_snapshot };
}
export function mergeCompletionClaims(claims: CompletionClaim[]): CompletionClaim[] {
  const byKey = new Map<string, CompletionClaim>();
  for (const c of claims) {
    const key = `${c.source_kind}:${c.source_id}`, previous = byKey.get(key);
    if (previous && (previous.source_hash !== c.source_hash || previous.capacity_cents !== c.capacity_cents))
      throw new BankingError("BANKING_SOURCE_CAPACITY_STALE", 409);
    byKey.set(key, { ...c, amount_cents: c.amount_cents + (previous?.amount_cents ?? 0) });
  }
  return [...byKey.values()];
}
export async function movementFacts(client: PoolClient, body: Omit<MovementInput, "id" | "expected_revision">) {
  const blockers = movementStructuralBlockers(body), claims: CompletionClaim[] = [];
  const snapshots: unknown[] = [], evidence = await completionEvidence(client, body.evidence_id);
  if (body.day > reviewToday()) blockers.push("BANKING_MOVEMENT_DATE_INVALID");
  const bank = await movementBank(client, body.bank_account_id, body.day);
  const accounts = await movementAccounts(client, [...new Set([...body.allocations.map(l => l.account_list_id),
    ...(body.transit_account_list_id ? [body.transit_account_list_id] : [])])], body.attested);
  const byId = new Map(accounts.map(a => [a.id, a]));
  for (const line of body.allocations) {
    const fact = await movementAllocationFact(client, line); snapshots.push(fact.snapshot); claims.push(...fact.claims);
  }
  let lines: CompletionLine[] = [];
  if (body.kind === "bank_transfer") {
    const transit = body.transit_account_list_id ? byId.get(body.transit_account_list_id) : undefined;
    if (!transit || transit.account_type !== "OtherCurrentAsset" || transit.currency !== "USD") blockers.push("BANKING_TRANSFER_TRANSIT_REQUIRED");
    else lines = [movementLine("bank", bank, body.amount_cents, false), movementLine("transit", transit, body.amount_cents, true)];
    if (body.destination_bank_account_id) {
      const destination = await movementBank(client, body.destination_bank_account_id, body.day);
      if (destination.id === bank.id || destination.id === transit?.id || bank.id === transit?.id) blockers.push("BANKING_TRANSFER_INVALID");
      snapshots.push({ destination });
    }
  } else {
    try { lines = buildMovementLines(body, bank, byId); }
    catch (error) { if (!(error instanceof BankingError)) throw error; blockers.push(error.code); }
  }
  if (body.transaction_id) claims.push(await movementTransaction(client, body.transaction_id, bank, body.day,
    body.amount_cents * (body.kind === "owner_contribution" ? -1 : 1)));
  const snapshot = { bank, accounts, evidence: { sha256: evidence.sha256, version: evidence.version }, sources: snapshots,
    transaction: claims.find(c => c.source_kind === "transaction")?.source_snapshot ?? null };
  return { snapshot, claims: mergeCompletionClaims(claims), lines, blockers: [...new Set(blockers)], accounts, bank };
}
export async function movementContext(client: PoolClient, id: string): Promise<MovementContext & {
  accounts: Awaited<ReturnType<typeof movementAccounts>>; source_labels: Record<string, string> }> {
  const { movement, source_snapshot } = await movementRow(client, id), postings = await completionHistory(client, "movement", id);
  let blockers: string[] = [], accounts: Awaited<ReturnType<typeof movementAccounts>> = [];
  const sourceLabels: Record<string, string> = {};
  try {
    const facts = await movementFacts(client, movement); blockers = facts.blockers; accounts = facts.accounts;
    for (const [index, allocation] of movement.allocations.entries()) {
      const identity = (facts.snapshot.sources[index] as { identity?: Record<string, unknown> } | undefined)?.identity;
      if (identity) sourceLabels[`${allocation.source_kind}:${allocation.source_id}`] = String(identity.number
        ?? identity.reference_id ?? identity.reference ?? identity.month ?? allocation.source_id);
    }
    if (reviewHash(facts.snapshot) !== reviewHash(source_snapshot)) blockers.push("BANKING_MOVEMENT_SOURCE_STALE");
    for (const entry of postings.filter(e => e.kind === "movement" && e.completion_stage === "incoming" && !e.reversed_by)) {
      const claims = (await client.query<{ source_id: string; source_hash: string }>(
        "SELECT source_id,source_hash FROM bank_source_claim WHERE entry_id=$1 AND source_kind='transaction'", [entry.id])).rows;
      const destination = await movementBank(client, movement.destination_bank_account_id!, entry.day);
      for (const claim of claims) {
        const live = await movementTransaction(client, claim.source_id, destination, entry.day, -movement.amount_cents);
        if (live.source_hash !== claim.source_hash) blockers.push("BANKING_MOVEMENT_SOURCE_STALE");
      }
    }
  } catch (error) { if (!(error instanceof BankingError)) throw error; blockers.push(error.code); }
  return { movement, postings, accounts, source_labels: sourceLabels, blockers: [...new Set(blockers)],
    linked_locally_cents: postings.some(e => e.kind === "movement" && e.completion_stage === "outgoing" && !e.reversed_by) ? movement.amount_cents : 0,
    external_balance: "unknown", coverage: "partial" };
}
export const readMovement = (id: string) => receiptRead(client => movementContext(client, id));
export const listMovements = () => receiptRead(async client => {
  const ids = (await client.query<{ id: string }>("SELECT id FROM bank_movement WHERE deleted_at IS NULL ORDER BY created_at DESC,id DESC LIMIT 150")).rows;
  const movements: MovementContext[] = [];
  for (const row of ids) movements.push(await movementContext(client, row.id));
  return { movements };
});
