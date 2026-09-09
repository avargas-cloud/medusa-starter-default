import type { PoolClient } from "pg";

import { appendReviewEvent } from "./review-common";

/** Runs inside the ingestion transaction, after its source_version has advanced. */
export async function invalidateBankSource(
  client: PoolClient,
  id: string,
  oldDay: string | null,
  newDay: string
): Promise<void> {
  const days = [...new Set([newDay, ...(oldDay ? [oldDay] : [])])];
  const closed = await client.query<{ day: string }>(
    `UPDATE bank_day_close SET needs_review=true,updated_at=now()
    WHERE day=ANY($1::text[]) AND status='closed' AND deleted_at IS NULL RETURNING day`,
    [days]
  );
  const before = (
    await client.query(
      "SELECT * FROM bank_transaction_review WHERE transaction_id=$1 AND deleted_at IS NULL",
      [id]
    )
  ).rows[0];
  if (!before && !closed.rowCount) return;
  // Closed decisions remain intact. The live source version marks them stale;
  // the immutable day snapshot is never reconstructed from this mutable row.
  if (before && !closed.rows.some((row) => row.day === newDay)) {
    await client.query(
      `UPDATE bank_transaction_review SET revision=revision+1,status='draft',
      confirmed_by=NULL,confirmed_at=NULL,matched_payment_id=NULL,match_snapshot=NULL,updated_at=now()
      WHERE transaction_id=$1 AND deleted_at IS NULL`,
      [id]
    );
  }
  await appendReviewEvent(client, {
    entity_type: "transaction",
    entity_id: id,
    transaction_id: id,
    action: "bank_source_changed",
    actor_id: "system",
    details: {
      before: before ?? null,
      old_day: oldDay,
      new_day: newDay,
      closed_days: closed.rows.map((row) => row.day),
    },
  });
}
