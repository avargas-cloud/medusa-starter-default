/**
 * src/api/admin/pos/price-batches/_lib/display-number.ts
 *
 * Sequential, gapless, human-readable numbering for price_change_batch —
 * same UPDATE ... RETURNING pattern as `allocateNextNumber` in
 * lib/invoices/document-numbering.ts:1779500000000, copied rather than
 * imported because that helper's `CounterName` union is invoice-specific and
 * this feature's writable scope doesn't include lib/invoices/**.
 *
 * MUST be called inside the same physical transaction that creates the
 * batch row — the counter increment is an `UPDATE ... RETURNING`, which row-
 * locks and rolls back WITH the transaction, so a failed batch create never
 * burns a number (that's what makes a counter row gapless where a Postgres
 * sequence is not).
 */

/** Minimal structural view of the MikroORM EntityManager (raw SQL only). */
export interface TxManager {
  execute<T = unknown>(sql: string, params?: unknown[]): Promise<T>;
}

const COUNTER_NAME = "price_change_batch";

/**
 * Atomically advance the `price_change_batch` counter row and return the new
 * value. Seeded/advanced by migration Migration20260811233000; throws if the
 * row is missing rather than silently falling back to some default (a
 * missing counter means the migration hasn't run).
 */
export async function allocateNextDisplayNumber(
  em: TxManager
): Promise<number> {
  const rows = await em.execute<Array<{ value: string | number }>>(
    `UPDATE document_number_counter
       SET value = value + 1, updated_at = now()
     WHERE name = ?
     RETURNING value`,
    [COUNTER_NAME]
  );
  const first = rows?.[0];
  if (!first) {
    throw new Error(
      `[price-batches] counter '${COUNTER_NAME}' is missing — run migration Migration20260811233000 / re-seed`
    );
  }
  return Number(first.value);
}
