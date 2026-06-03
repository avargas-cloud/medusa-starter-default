export interface KnexLike {
  raw: (
    sql: string,
    bindings?: unknown[]
  ) => Promise<{ rowCount?: number; rows?: Array<Record<string, unknown>> }>;
}

/**
 * Atomic, availability-guarded stock move on an inventory_level row.
 *
 * The guard (`stocked + delta >= reserved` and `>= 0`) lives INSIDE the single
 * UPDATE's WHERE clause, so the read-check-write is one statement — no TOCTOU
 * window where a concurrent reservation/receipt-edit could slip in between a
 * read and a write (the previous check-then-adjustInventory had one). A return
 * of `false` (rowCount 0) means the guard rejected the move (only possible for
 * a decrement).
 *
 * Writes `raw_stocked_quantity` alongside `stocked_quantity` because Medusa's
 * BigNumber columns read from the raw_* JSONB; updating only the numeric column
 * would desync them. This raw UPDATE still fires `trg_meili_sync_inventory_level`
 * (writer-agnostic), so the Meili sync is preserved; factory orders never touch
 * QuickBooks.
 *
 * `guarded` (default true) enforces availability. Pass `false` for compensation,
 * which reverses our own change and must always apply.
 */
export async function atomicStockMove(
  knex: KnexLike,
  itemId: string,
  locationId: string,
  delta: number,
  guarded = true
): Promise<boolean> {
  const guardClause = guarded
    ? `AND (? >= 0 OR (stocked_quantity + ? >= 0 AND stocked_quantity + ? >= reserved_quantity))`
    : "";
  const bindings = guarded
    ? [delta, delta, itemId, locationId, delta, delta, delta]
    : [delta, delta, itemId, locationId];
  const r = await knex.raw(
    `UPDATE inventory_level
        SET stocked_quantity = stocked_quantity + ?,
            raw_stocked_quantity = jsonb_build_object(
              'value', (stocked_quantity + ?)::text, 'precision', 20
            ),
            updated_at = NOW()
      WHERE inventory_item_id = ?
        AND location_id = ?
        AND deleted_at IS NULL
        ${guardClause}`,
    bindings
  );
  return (r.rowCount ?? 0) === 1;
}
