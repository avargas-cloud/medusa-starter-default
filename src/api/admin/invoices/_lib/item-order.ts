/**
 * src/api/admin/invoices/_lib/item-order.ts
 *
 * pos_invoice_item / credit_memo_item rows have NO ordering column, and their
 * `items` hasMany relation is returned by Postgres in arbitrary order when loaded
 * via `relations: ["items"]` (MikroORM applies no default ORDER BY).
 *
 * Line items are inserted in the exact order the POS client sends them — products
 * and comment/header lines are already merged and sorted by `sort_order` on the
 * client (CompleteOrderModal) before the POST. Their ULID `id`s are monotonic in
 * insertion order, so sorting by `id` ASC faithfully restores the on-screen order
 * the operator built (e.g. comment/header lines stay at the top of the document).
 *
 * Without this, comment lines drift to the middle of the invoice even though the
 * stored data is correct — a read-only ordering bug, not a data bug.
 */
export function sortDocItemsByInsertion<T extends { id?: string | null }>(
  items: T[] | null | undefined
): T[] {
  return [...(items ?? [])].sort((a, b) => {
    const ai = a.id ?? "";
    const bi = b.id ?? "";
    return ai < bi ? -1 : ai > bi ? 1 : 0;
  });
}
