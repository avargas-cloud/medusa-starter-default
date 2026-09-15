import { z } from "zod";

import { getDbPool } from "../../api/utils/db-pool";

import { withReviewLock } from "./review-common";
import { BankingError, bankingEnvSql } from "./security";
import { matchStatement } from "./statement-matching";
import { statementCents } from "./statement-types";
import { transaction } from "./store";
import { refreshStatementSuggestions } from "./suggestion-runner";

/**
 * Confirm del contador sobre una línea del feed con SUGERENCIA (o candidatos elegidos a mano):
 * crea el/los `bank_statement_match` contra el borrador del mes por `matchStatement` — la misma
 * función que usa la pantalla Statements, con `expected_book_hash` (si el asiento cambió, 409) y
 * el trigger de capacidad de la línea. Después recalcula las sugerencias de ese extracto: casar
 * una línea cambia los empates de las otras (2026-09-15).
 *
 * Es el único camino que escribe un match hacia adelante; el job y el botón Refresh nunca lo hacen.
 */
export const feedConfirmMatchSchema = z
  .object({
    allocations: z
      .array(
        z
          .object({
            book_id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
            amount_cents: statementCents.positive(),
            expected_book_hash: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict()
      )
      .min(1)
      .max(20),
  })
  .strict();
export type FeedConfirmMatchBody = z.infer<typeof feedConfirmMatchSchema>;

export type FeedLineTarget = {
  transaction_id: string;
  statement_id: string;
  statement_line_id: string;
  statement_revision: number;
  statement_status: string;
  line_amount_cents: number;
  matched_cents: number;
  transaction_status: string;
};

/** La línea de extracto EN BORRADOR de una transacción del feed. 409 con motivo nombrado si no hay. */
export async function feedLineTarget(transactionId: string): Promise<FeedLineTarget> {
  const client = await getDbPool().connect();
  try {
    return await transaction(client, async () => {
      await withReviewLock(client);
      const row = (
        await client.query<FeedLineTarget>(
          `SELECT t.id AS transaction_id,st.id AS statement_id,sl.id AS statement_line_id,st.revision AS statement_revision,
                  st.status AS statement_status,sl.amount_cents::float8 AS line_amount_cents,t.status AS transaction_status,
                  COALESCE((SELECT SUM(m.amount_cents)::float8 FROM bank_statement_match m WHERE m.statement_line_id=sl.id AND m.deleted_at IS NULL),0) AS matched_cents
             FROM bank_transaction t
             JOIN bank_account a ON a.id=t.account_id AND a.deleted_at IS NULL
             JOIN bank_connection c ON c.id=a.connection_id AND c.deleted_at IS NULL AND c.environment=${bankingEnvSql()}
             LEFT JOIN bank_statement_line sl ON sl.transaction_id=t.id AND sl.deleted_at IS NULL
             LEFT JOIN bank_statement st ON st.id=sl.statement_id AND st.deleted_at IS NULL
            WHERE t.id=$1 AND t.deleted_at IS NULL
            ORDER BY (st.status='draft') DESC NULLS LAST LIMIT 1`,
          [transactionId]
        )
      ).rows[0];
      if (!row) throw new BankingError("BANKING_TRANSACTION_NOT_FOUND", 404);
      if (row.transaction_status !== "posted") throw new BankingError("BANKING_POSTED_TRANSACTION_REQUIRED", 409);
      if (!row.statement_id) throw new BankingError("BANKING_FEED_LINE_NOT_IN_STATEMENT", 409);
      if (row.statement_status !== "draft") throw new BankingError("BANKING_STATEMENT_PERIOD_CLOSED", 409);
      return row;
    });
  } finally {
    client.release();
  }
}

export async function confirmFeedMatch(
  transactionId: string,
  actorId: string,
  key: string,
  input: unknown
): Promise<{ statement_id: string; statement_line_id: string; revision: number; matched: number; suggestions: "refreshed" | "failed" }> {
  const body = feedConfirmMatchSchema.parse(input);
  const target = await feedLineTarget(transactionId);
  // La capacidad de la línea la afirma el trigger de `bank_statement_match` (suma CON signo: un
  // neteo mezcla depósitos y reembolsos); acá sólo se nombra el caso obvio.
  if (target.matched_cents > 0 && body.allocations.length === 1 && target.matched_cents >= Math.abs(target.line_amount_cents))
    throw new BankingError("BANKING_FEED_LINE_ALREADY_MATCHED", 409);
  const ctx = await matchStatement(target.statement_id, actorId, key, {
    expected_revision: target.statement_revision,
    allocations: body.allocations.map((a) => ({
      statement_line_id: target.statement_line_id,
      book_kind: "journal_line" as const,
      book_id: a.book_id,
      amount_cents: a.amount_cents,
      expected_book_hash: a.expected_book_hash,
    })),
  });
  const refreshed = await refreshStatementSuggestions(target.statement_id, actorId, "confirm");
  return {
    statement_id: target.statement_id,
    statement_line_id: target.statement_line_id,
    revision: ctx.statement.revision,
    matched: body.allocations.length,
    suggestions: refreshed.outcome.status === "ok" ? "refreshed" : "failed",
  };
}
