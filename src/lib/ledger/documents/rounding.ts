import { createHash } from "node:crypto";
import type { PoolClient } from "pg";

import { getBusinessDateString } from "../../date/et";
import { loadAccountMap } from "../accounts";
import { buildRoundingLines } from "../lines/rounding";
import { postDocumentJournal, reverseDocumentJournal } from "../post";
import { LedgerAccount, LedgerError, PostResult, ReverseResult, RoundingDirection } from "../types";

type RoundingRow = {
  id: string;
  amount_cents: number;
  direction: string;
  account_list_id: string;
  created_at: string;
  voided_at: string | null;
};

async function loadRow(
  client: PoolClient,
  id: string
): Promise<RoundingRow | null> {
  const { rows } = await client.query<RoundingRow>(
    `SELECT id, amount_cents, direction, account_list_id, created_at::text, voided_at::text
     FROM pos_rounding_adjustment WHERE id = $1 AND deleted_at IS NULL`,
    [id]
  );
  return rows[0] ?? null;
}

async function loadRoundingAccount(
  client: PoolClient,
  qbListId: string
): Promise<LedgerAccount> {
  const { rows } = await client.query<{
    qb_list_id: string;
    name: string;
    account_type: string;
    normal_balance: string | null;
  }>(
    `SELECT qb_list_id, name, account_type, normal_balance FROM qb_account
     WHERE qb_list_id = $1 AND is_active = true LIMIT 1`,
    [qbListId]
  );
  const row = rows[0];
  if (!row) throw new LedgerError("GL_ACCOUNT_MAP_MISSING", { qbListId });
  return {
    id: row.qb_list_id,
    name: row.name,
    account_type: row.account_type,
    currency: "USD",
    normal_balance:
      row.normal_balance === "debit" || row.normal_balance === "credit"
        ? row.normal_balance
        : null,
  };
}

export async function postRoundingAdjustment(
  client: PoolClient,
  roundingId: string,
  actorId: string
): Promise<PostResult> {
  const row = await loadRow(client, roundingId);
  if (!row) throw new LedgerError("GL_SOURCE_INVALID", { roundingId });
  if (row.voided_at) throw new LedgerError("GL_SOURCE_INVALID", { voided: true });
  if (row.direction !== "shortage" && row.direction !== "overage")
    throw new LedgerError("GL_SOURCE_INVALID", { direction: row.direction });

  const map = await loadAccountMap(client);
  const account = await loadRoundingAccount(client, row.account_list_id);
  const lines = buildRoundingLines(
    {
      amountCents: BigInt(row.amount_cents),
      direction: row.direction as RoundingDirection,
      account,
    },
    map
  );
  const day = getBusinessDateString(row.created_at);
  const sourceSnapshot = { row };
  const sourceHash = createHash("sha256")
    .update(JSON.stringify(sourceSnapshot))
    .digest("hex");

  return postDocumentJournal(client, {
    source_kind: "rounding_adjustment",
    source_id: roundingId,
    document_number: roundingId,
    day,
    reference: roundingId,
    description: `Rounding adjustment ${roundingId}`,
    lines,
    source_snapshot: sourceSnapshot,
    source_hash: sourceHash,
    actor_id: actorId,
  });
}

export async function reverseRoundingAdjustment(
  client: PoolClient,
  roundingId: string,
  actorId: string,
  reason = "rounding adjustment voided"
): Promise<ReverseResult> {
  const row = await loadRow(client, roundingId);
  if (!row) return { status: "nothing_to_reverse" };
  const day = getBusinessDateString(row.voided_at ?? row.created_at);
  return reverseDocumentJournal(client, {
    source_kind: "rounding_adjustment",
    source_id: roundingId,
    day,
    reason,
    actor_id: actorId,
  });
}
