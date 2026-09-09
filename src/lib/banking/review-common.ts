import { createHash } from "node:crypto";

import type { PoolClient } from "pg";

import { getDbPool } from "../../api/utils/db-pool";

import { BankingError, requireBankingEnabled } from "./security";
import { bankId, transaction } from "./store";

export async function withReviewLock(client: PoolClient): Promise<void> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('banking-review', 7241))"
  );
}

export function reviewHash(value: unknown): string {
  const canonical = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonical);
    if (input instanceof Date) return input.toISOString();
    if (input && typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, entry]) => [key, canonical(entry)])
      );
    }
    return input;
  };
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

export const stableReviewHash = reviewHash;

export async function reviewCapacity(
  client: PoolClient,
  table: string,
  cap: number
): Promise<void> {
  const allowed = [
    "bank_transaction_review",
    "bank_review_rule",
    "bank_review_event",
    "bank_day_close",
    "bank_review_attachment",
    "bank_review_permission",
    "bank_deposit",
    "bank_deposit_line",
    "bank_direct_expense",
    "bank_journal_entry",
    "bank_journal_line",
    "bank_accounting_setup",
    "bank_receipt_accounting",
    "bank_receipt_consumption",
    "bank_opening_balance",
    "bank_opening_item",
    "bank_opening_clear",
    "bank_opening_evidence",
  ];
  if (!allowed.includes(table))
    throw new BankingError("BANKING_CAPACITY_INVALID", 500);
  const result = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM ${table}`
  );
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- COUNT(*) always returns exactly one row
  if (Number(result.rows[0]!.count) >= cap)
    throw new BankingError("BANKING_SANDBOX_CAP_REACHED", 409);
}

type ReviewEvent = {
  entity_type: string;
  entity_id: string;
  transaction_id?: string | null;
  action: string;
  actor_id: string;
  details: unknown;
};

export async function appendReviewEvent(
  client: PoolClient,
  event: ReviewEvent
): Promise<void> {
  await reviewCapacity(client, "bank_review_event", 10000);
  await client.query(
    `INSERT INTO bank_review_event
    (id,entity_type,entity_id,transaction_id,action,actor_id,details)
    VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
    [
      bankId("bre"),
      event.entity_type,
      event.entity_id,
      event.transaction_id ?? null,
      event.action,
      event.actor_id,
      JSON.stringify(event.details),
    ]
  );
}

export type ReviewCommand = {
  actorId: string;
  operation: string;
  entityId: string;
  key: string | undefined;
  body: unknown;
};

/** Receipt and business effects commit together; retries never repeat mutations. */
export async function runReviewCommand<T>(
  command: ReviewCommand,
  callback: (client: PoolClient) => Promise<T>
): Promise<T> {
  requireBankingEnabled();
  if (
    typeof command.key !== "string" ||
    !/^[A-Za-z0-9_.:-]{1,128}$/.test(command.key)
  ) {
    throw new BankingError("BANKING_IDEMPOTENCY_KEY_REQUIRED");
  }
  const key = reviewHash([
    command.actorId,
    command.operation,
    command.entityId,
    command.key,
  ]);
  const hash = reviewHash(command.body);
  const client = await getDbPool().connect();
  try {
    return await transaction(client, async () => {
      await withReviewLock(client);
      const receipt = await client.query<{ request_hash: string; result: T }>(
        "SELECT request_hash,result FROM bank_review_event WHERE idempotency_key=$1",
        [key]
      );
      if (receipt.rows[0]) {
        if (receipt.rows[0].request_hash !== hash)
          throw new BankingError("BANKING_IDEMPOTENCY_CONFLICT", 409);
        return receipt.rows[0].result;
      }
      await reviewCapacity(client, "bank_review_event", 10000);
      const result = await callback(client);
      await reviewCapacity(client, "bank_review_event", 10000);
      await client.query(
        `INSERT INTO bank_review_event
        (id,entity_type,entity_id,action,actor_id,details,idempotency_key,request_hash,result)
        VALUES ($1,'command',$2,$3,$4,'{}'::jsonb,$5,$6,$7::jsonb)`,
        [
          bankId("bre"),
          command.entityId,
          command.operation,
          command.actorId,
          key,
          hash,
          JSON.stringify(result),
        ]
      );
      return result;
    });
  } finally {
    client.release();
  }
}

export async function requireOpenReviewDay(
  client: PoolClient,
  day: string
): Promise<void> {
  const result = await client.query<{ closed: boolean }>(
    `SELECT EXISTS(
    SELECT 1 FROM bank_day_close WHERE day=$1 AND status='closed' AND deleted_at IS NULL) AS closed`,
    [day]
  );
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- SELECT EXISTS(...) always returns exactly one row
  if (result.rows[0]!.closed) throw new BankingError("BANKING_DAY_CLOSED", 409);
}
