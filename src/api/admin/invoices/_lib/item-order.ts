/**
 * src/api/admin/invoices/_lib/item-order.ts
 *
 * pos_invoice_item / credit_memo_item `items` hasMany relations come back from
 * Postgres in arbitrary order (MikroORM applies no default ORDER BY), so every
 * display read must sort explicitly.
 *
 * Ordering contract (2026-08-10):
 *   1. `sort_order` ASC when present — the 0-indexed display position
 *      snapshotted at creation from the array the POS sends (products and
 *      comment/header lines already merged and sorted client-side).
 *   2. Fallback `id` ASC for legacy rows (sort_order NULL).
 *
 * The id fallback is BEST-EFFORT only: ULIDs are monotonic across
 * milliseconds but random WITHIN one, and batch inserts routinely land in a
 * single ms — that's exactly how comment/header lines drifted mid-document
 * twice (2026-07-02 report, 2026-08-10 recurrence). Never rely on id order
 * for new writes; persist sort_order instead.
 */
export function sortDocItemsByInsertion<
  T extends { id?: string | null; sort_order?: number | null }
>(items: T[] | null | undefined): T[] {
  return [...(items ?? [])].sort((a, b) => {
    const as = a.sort_order;
    const bs = b.sort_order;
    const aHas = typeof as === "number";
    const bHas = typeof bs === "number";
    if (aHas && bHas && as !== bs) return (as as number) - (bs as number);
    if (aHas !== bHas) return aHas ? -1 : 1; // rows with sort_order first
    const ai = a.id ?? "";
    const bi = b.id ?? "";
    return ai < bi ? -1 : ai > bi ? 1 : 0;
  });
}
