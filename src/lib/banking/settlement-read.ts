import type { PoolClient } from "pg";

import { completionEvidence } from "./completion-evidence";
import { completionHistory } from "./completion-journal";
import { mergeCompletionClaims } from "./movement-read";
import {
  movementAccounts,
  movementBank,
  movementTransaction,
} from "./movement-source";
import type { CompletionClaim, CompletionLine } from "./movement-types";
import { receiptRead } from "./receipts-setup";
import { reviewHash } from "./review-common";
import { reviewToday } from "./review-date";
import { BankingError } from "./security";
import {
  buildSettlementLines,
  settlementStructuralBlockers,
  settlementTotals,
} from "./settlement-rules";
import { settlementLineFact } from "./settlement-source";
import type {
  SettlementContext,
  SettlementDocument,
  SettlementInput,
} from "./settlement-types";

export async function settlementRow(
  client: PoolClient,
  id: string
): Promise<{ settlement: SettlementDocument; source_snapshot: unknown }> {
  const row = (
    await client.query<{
      id: string;
      revision: number;
      payload: Omit<SettlementInput, "id" | "expected_revision">;
      source_snapshot: unknown;
      created_by: string;
      created_at: string;
    }>(
      "SELECT * FROM bank_merchant_settlement WHERE id=$1 AND deleted_at IS NULL FOR SHARE",
      [id]
    )
  ).rows[0];
  if (!row) throw new BankingError("BANKING_SETTLEMENT_NOT_FOUND", 404);
  return {
    settlement: {
      ...row.payload,
      id: row.id,
      revision: row.revision,
      created_by: row.created_by,
      created_at: row.created_at,
    } as SettlementDocument,
    source_snapshot: row.source_snapshot,
  };
}
type SettlementFacts = {
  snapshot: {
    bank: Awaited<ReturnType<typeof movementBank>>;
    accounts: Awaited<ReturnType<typeof movementAccounts>>;
    evidence: { sha256: string; version: number };
    sources: unknown[];
    transaction: unknown;
  };
  claims: CompletionClaim[];
  lines: CompletionLine[];
  accounts: Awaited<ReturnType<typeof movementAccounts>>;
  totals: ReturnType<typeof settlementTotals>;
  blockers: string[];
};

export async function settlementFacts(
  client: PoolClient,
  body: Omit<SettlementInput, "id" | "expected_revision">
): Promise<SettlementFacts> {
  const blockers = settlementStructuralBlockers(body.lines),
    totals = settlementTotals(body.lines);
  const bank = await movementBank(client, body.bank_account_id, body.day);
  const evidence = await completionEvidence(client, body.evidence_id);
  const accounts = await movementAccounts(
    client,
    [...new Set(body.lines.map((l) => l.account_list_id))],
    body.attested
  );
  if (!body.attested) blockers.push("BANKING_SETTLEMENT_ATTESTATION_REQUIRED");
  if (body.day > reviewToday())
    blockers.push("BANKING_SETTLEMENT_DATE_INVALID");
  if ((totals.net_cents === 0) !== (body.transaction_id === null))
    blockers.push("BANKING_SETTLEMENT_BANK_EVIDENCE_REQUIRED");
  const claims: CompletionClaim[] = [],
    sources: unknown[] = [];
  for (const line of body.lines) {
    try {
      const fact = await settlementLineFact(client, line, body.day);
      claims.push(...fact.claims);
      sources.push(fact.snapshot);
    } catch (error) {
      if (!(error instanceof BankingError)) throw error;
      blockers.push(error.code);
      sources.push({ blocked: error.code });
    }
  }
  if (body.transaction_id && totals.net_cents !== 0)
    claims.push(
      await movementTransaction(
        client,
        body.transaction_id,
        bank,
        body.day,
        -totals.net_cents
      )
    );
  let lines: CompletionLine[] = [];
  try {
    lines = buildSettlementLines(
      body.lines,
      bank,
      new Map(accounts.map((a) => [a.id, a]))
    );
  } catch (error) {
    if (!(error instanceof BankingError)) throw error;
    blockers.push(error.code);
  }
  const snapshot = {
    bank,
    accounts,
    evidence: { sha256: evidence.sha256, version: evidence.version },
    sources,
    transaction:
      claims.find((c) => c.source_kind === "transaction")?.source_snapshot ??
      null,
  };
  return {
    snapshot,
    claims: mergeCompletionClaims(claims),
    lines,
    accounts,
    totals,
    blockers: [...new Set(blockers)],
  };
}
export async function settlementContext(
  client: PoolClient,
  id: string
): Promise<
  SettlementContext & { accounts: Awaited<ReturnType<typeof movementAccounts>> }
> {
  const { settlement, source_snapshot } = await settlementRow(client, id),
    postings = await completionHistory(client, "merchant_settlement", id);
  let blockers: string[] = [],
    accounts: Awaited<ReturnType<typeof movementAccounts>> = [];
  try {
    const facts = await settlementFacts(client, settlement);
    blockers = facts.blockers;
    accounts = facts.accounts;
    if (reviewHash(facts.snapshot) !== reviewHash(source_snapshot))
      blockers.push("BANKING_SETTLEMENT_SOURCE_STALE");
  } catch (error) {
    if (!(error instanceof BankingError)) throw error;
    blockers.push(error.code);
  }
  return {
    settlement,
    postings,
    accounts,
    totals: settlementTotals(settlement.lines),
    blockers: [...new Set(blockers)],
    coverage: "partial",
  };
}
export const readSettlement = (
  id: string
): Promise<
  SettlementContext & { accounts: Awaited<ReturnType<typeof movementAccounts>> }
> => receiptRead((client) => settlementContext(client, id));
export const listSettlements = (): Promise<{
  settlements: SettlementContext[];
}> =>
  receiptRead(async (client) => {
    const ids = (
      await client.query<{ id: string }>(
        "SELECT id FROM bank_merchant_settlement WHERE deleted_at IS NULL ORDER BY created_at DESC,id DESC LIMIT 100"
      )
    ).rows;
    const settlements: SettlementContext[] = [];
    for (const row of ids)
      settlements.push(await settlementContext(client, row.id));
    return { settlements };
  });
