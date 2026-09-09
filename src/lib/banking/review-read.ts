import { getDbPool } from "../../api/utils/db-pool";

import { openingClearProjection } from "./opening-guards";
import {
  ATTACHMENT_COLUMNS,
  type ReviewAttachment,
} from "./review-attachments";
import { REVIEW_JOINS, REVIEW_SELECT_SQL } from "./review-projection";
import { BankingError, requireBankingEnabled, bankingEnvSql } from "./security";
import type { BankTransactionView } from "./views";

export async function readTransactionReview(id: string): Promise<{
  transaction: BankTransactionView & {
    opening_clear?: { id: string; item_id: string; reference: string };
  };
  review: BankTransactionView["review"];
  attachments: ReviewAttachment[];
  events: Array<{
    id: string;
    action: string;
    actor_id: string;
    details: unknown;
    created_at: Date;
  }>;
  day_closed: BankTransactionView["day_closed"];
  stale: BankTransactionView["stale"];
}> {
  requireBankingEnabled();
  const client = await getDbPool().connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const result = await client.query<BankTransactionView>(
      `SELECT ${REVIEW_SELECT_SQL}
      FROM bank_transaction t JOIN bank_account a ON a.id=t.account_id
      JOIN bank_connection c ON c.id=a.connection_id ${REVIEW_JOINS}
      WHERE t.id=$1 AND t.deleted_at IS NULL AND a.deleted_at IS NULL
      AND c.deleted_at IS NULL AND c.environment=${bankingEnvSql()}`,
      [id]
    );
    const tx = result.rows[0];
    if (!tx) throw new BankingError("BANKING_TRANSACTION_NOT_FOUND", 404);
    const attachments = await client.query<ReviewAttachment>(
      `SELECT ${ATTACHMENT_COLUMNS}
      FROM bank_review_attachment WHERE transaction_id=$1 AND deleted_at IS NULL
      AND detached_at IS NULL ORDER BY created_at,id`,
      [id]
    );
    const events = await client.query<{
      id: string;
      action: string;
      actor_id: string;
      details: unknown;
      created_at: Date;
    }>(
      `SELECT id,action,actor_id,details,created_at FROM bank_review_event
       WHERE transaction_id=$1 AND deleted_at IS NULL ORDER BY created_at,id`,
      [id]
    );
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- openingClearProjection maps its input array 1:1, so passing a single-element array returns a single-element array
    const projected = (await openingClearProjection(client, [tx]))[0]!;
    await client.query("COMMIT");
    return {
      transaction: projected,
      review: tx.review,
      attachments: attachments.rows,
      events: events.rows,
      day_closed: tx.day_closed,
      stale: tx.stale,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
