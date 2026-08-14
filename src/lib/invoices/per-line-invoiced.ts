/**
 * Attributes an order's invoiced quantities to its lines when the invoice
 * items themselves don't say which line they billed.
 *
 * `pos_invoice_item.order_line_item_id` only exists since 2026-08-08; every
 * invoice before that (and any path that still omits it) bills a variant, not
 * a line. For those, coverage is allocated here: a FIFO pool per variant/SKU,
 * consumed line by line in display order — the same matching rule
 * `computeFullyInvoiced` uses (variant_id match, SKU as fallback), generalized
 * from "is everything covered?" to "how much of each line is covered?".
 *
 * Duplicate-SKU caveat, on purpose: when two lines share a variant, which of
 * them the pool fills first is a convention (display order), not a fact.
 * That ambiguity cannot move any number this feeds — order-level status and
 * pending totals sum over the lines, and the sum is invariant under how the
 * pool splits between twins.
 */

export interface LineForInvoicedAllocation {
  lineId: string;
  variantId: string | null;
  sku: string | null;
  quantity: number;
  /** Quantity already attributed to this exact line via order_line_item_id. */
  directInvoiced: number;
}

export interface UnattributedInvoicedPoolEntry {
  variantId: string | null;
  sku: string | null;
  quantity: number;
}

function nz(v: number): number {
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * @returns total invoiced per lineId — direct attribution PLUS the pool
 * allocation, capped at the line's quantity.
 */
export function allocateInvoicedToLines(
  lines: ReadonlyArray<LineForInvoicedAllocation>,
  unattributed: ReadonlyArray<UnattributedInvoicedPoolEntry>
): Map<string, number> {
  const pool = unattributed.map((it) => ({
    variantId: it.variantId ?? null,
    sku: it.sku ?? null,
    remaining: nz(it.quantity),
  }));

  const out = new Map<string, number>();
  for (const line of lines) {
    const direct = Math.min(nz(line.directInvoiced), nz(line.quantity));
    let capacity = Math.max(0, nz(line.quantity) - direct);
    let allocated = 0;
    while (capacity > 0) {
      const entry = pool.find(
        (p) =>
          p.remaining > 0 &&
          ((!!line.variantId && p.variantId === line.variantId) ||
            (!!line.sku && p.sku === line.sku))
      );
      if (!entry) break;
      const take = Math.min(entry.remaining, capacity);
      entry.remaining -= take;
      capacity -= take;
      allocated += take;
    }
    out.set(line.lineId, direct + allocated);
  }
  return out;
}
