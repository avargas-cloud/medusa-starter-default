/**
 * src/lib/cost/restatement/movement-ledger.ts
 *
 * Reconstructs the per-variant quantity timeline of the Miami costing pool from
 * the immutable movement records, so a cost replay can be quantity-faithful
 * instead of trusting a single captured number.
 *
 * WHY NOT JUST TRUST `qty_on_hand_at_receive`?
 * It is captured per LOCATION at receipt time, while `average_cost` is a single
 * global per-variant field — so the old AVCO mixed a Miami-scoped "quantity
 * before" with a global "quantity on hand" fallback. Worse, a single captured
 * integer cannot be verified: if it was wrong, nothing downstream notices. A
 * reconstructed timeline can be tied back to today's actual `stocked_quantity`,
 * which turns "trust me" into "this ties, and here is the residual".
 *
 * THE COSTING POOL IS MIAMI. Every purchase-order receipt of a China product
 * lands in Miami (222 of 222 lines), and the vendor-bill landed cost is
 * precisely the cost of getting the goods TO Miami. Stock sitting in the China
 * Warehouse has not incurred ocean freight or duty yet and is a different
 * economic stage; it is deliberately OUT of this pool and reported separately
 * rather than silently valued at the Miami landed average.
 *
 * MOVEMENT SOURCES (all Miami, all excluding voided/deleted documents):
 *   +  purchase-order receipts    goods arriving from the vendor
 *   +  credit memos               customer returns
 *   -  invoices                   sales
 *   +/- inventory counts          physical-count corrections
 *
 * INVENTORY TRANSFERS ARE DELIBERATELY EXCLUDED. A China arrival is recorded
 * TWICE — once as a purchase-order receipt and once as a China -> Miami
 * transfer — and they are the same physical units: EAP-AR1-8B shows
 * RCP-1007 (50 units) and IT-1006 (50 units) on the same 2026-05-05, then
 * RCP-1069 (75) and IT-1029 (75) on the same 2026-06-09. Counting both makes 57
 * variants solve to a NEGATIVE opening balance, which is impossible; counting
 * receipts alone leaves 2. Of 208 transfer/date pairs, 164 have a receipt the
 * same day and 150 match to the unit, and NO variant has a transfer without a
 * receipt — so the receipt is the complete Miami inbound and the transfer is
 * the paperwork for the leg out of the China warehouse.
 *
 * The receipt is also the right one to keep on its merits: it is the document
 * the vendor bill attaches its landed cost to.
 *
 * Ordering is by economic date, NOT by insertion order: `issued_at` for an
 * invoice, `received_at` for a receipt or transfer, `applied_at` for a count.
 * Ties break on a stable (kind, id) so a replay is byte-for-byte reproducible.
 */

export type MovementKind =
  | "receipt"
  | "transfer_in"
  | "sale"
  | "return"
  | "count_adjustment";

export interface VariantMovement {
  variantId: string;
  sku: string | null;
  kind: MovementKind;
  /** Economic date. Signed quantity applies to the Miami pool on this date. */
  effectiveAt: Date;
  /** Positive = into the pool, negative = out of it. */
  quantityDelta: number;
  /** Row id of the underlying record — the audit join key. */
  sourceId: string;
  /** Parent document id (receipt, invoice, credit memo, transfer, count). */
  sourceDocumentId: string | null;
}

const MIAMI_POOL_SQL = `sl.name = 'Ecopowertech Miami'`;

/**
 * One UNION ALL over every movement source. Kept as a single query because the
 * ordering has to be global across sources — merging five separately-sorted
 * lists in JS is how off-by-one sequencing bugs get in.
 */
export const MOVEMENT_LEDGER_SQL = `
WITH china_variants AS (
  SELECT pv.id, pv.sku
    FROM product_variant pv
    JOIN product p ON p.id = pv.product_id
   WHERE pv.deleted_at IS NULL
     -- COALESCE to false: (NULL = 'true') is NULL, and NOT NULL is NULL, so a
     -- product without the key would silently fall out of every branch.
     AND COALESCE((p.metadata->>'is_sourced_via_agent') = 'true', false)
),
movements AS (
  -- Goods arriving from the vendor. Voided receipts never happened.
  SELECT cv.id AS variant_id, cv.sku, 'receipt' AS kind,
         r.received_at AS effective_at,
         rl.qty_received_now AS quantity_delta,
         rl.id AS source_id, r.id AS source_document_id
    FROM purchase_order_receipt_line rl
    JOIN purchase_order_receipt r ON r.id = rl.purchase_order_receipt_id
    JOIN stock_location sl ON sl.id = r.stock_location_id
    JOIN china_variants cv ON cv.id = rl.product_variant_id
   WHERE rl.deleted_at IS NULL AND r.deleted_at IS NULL
     AND r.voided_at IS NULL AND ${MIAMI_POOL_SQL}
     AND rl.qty_received_now <> 0

  -- (No transfer_in branch: see the header — a China arrival is recorded as
  -- BOTH a receipt and a transfer, and counting both double-counts the units.)

  UNION ALL

  -- Sales. issued_at is the economic date; created_at is when the row was
  -- written and differs on backdated invoices.
  SELECT cv.id, cv.sku, 'sale',
         COALESCE(i.issued_at, i.created_at),
         -ii.quantity,
         ii.id, i.id
    FROM pos_invoice_item ii
    JOIN pos_invoice i ON i.id = ii.invoice_id
    JOIN china_variants cv ON cv.sku = ii.sku
   WHERE ii.deleted_at IS NULL AND i.deleted_at IS NULL
     AND i.voided_at IS NULL
     AND ii.quantity <> 0

  UNION ALL

  -- Customer returns put units back. Only completed credit memos moved stock.
  SELECT cv.id, cv.sku, 'return',
         COALESCE(cm.completed_at, cm.created_at),
         cmi.quantity,
         cmi.id, cm.id
    FROM pos_credit_memo_item cmi
    JOIN pos_credit_memo cm ON cm.id = cmi.credit_memo_id
    JOIN china_variants cv ON cv.sku = cmi.sku
   WHERE cmi.deleted_at IS NULL AND cm.deleted_at IS NULL
     AND cm.voided_at IS NULL AND cm.completed_at IS NOT NULL
     AND cmi.quantity <> 0

  UNION ALL

  -- Physical counts. delta_applied is what actually hit stock (delta_original
  -- is the proposal); a partially-applied count carries the real figure too.
  SELECT cv.id, cv.sku, 'count_adjustment',
         c.applied_at,
         cl.delta_applied,
         cl.id, c.id
    FROM inventory_count_line cl
    JOIN inventory_count c ON c.id = cl.inventory_count_id
    JOIN stock_location sl ON sl.id = c.stock_location_id
    JOIN china_variants cv ON cv.id = cl.product_variant_id
   WHERE c.applied_at IS NOT NULL
     AND ${MIAMI_POOL_SQL}
     AND COALESCE(cl.delta_applied, 0) <> 0
)
SELECT variant_id, sku, kind, effective_at, quantity_delta, source_id, source_document_id
  FROM movements
 WHERE effective_at IS NOT NULL
   -- Bound through knex, so the placeholder style is the knex one. NEVER write
   -- a literal question mark in a comment here: knex counts it as another
   -- placeholder and the query dies with "Expected 1 bindings, saw 2".
   AND effective_at <= ?
 ORDER BY variant_id, effective_at, kind, source_id
`;

export interface MovementLedgerRow {
  variant_id: string;
  sku: string | null;
  kind: MovementKind;
  effective_at: string;
  quantity_delta: number | string;
  source_id: string;
  source_document_id: string | null;
}

export interface VariantTimeline {
  variantId: string;
  sku: string | null;
  movements: VariantMovement[];
  /** Pool quantity after replaying every movement, from an opening of 0. */
  reconstructedEndingQuantity: number;
}

/**
 * Group the flat ledger into per-variant timelines. The rows must already be
 * ordered by the SQL above — this preserves that order rather than re-sorting,
 * so the economic sequence has exactly one authority.
 */
export function groupMovements(rows: readonly MovementLedgerRow[]): Map<string, VariantTimeline> {
  const byVariant = new Map<string, VariantTimeline>();

  for (const row of rows) {
    const delta = Number(row.quantity_delta);
    if (!Number.isFinite(delta)) continue;

    let timeline = byVariant.get(row.variant_id);
    if (!timeline) {
      timeline = {
        variantId: row.variant_id,
        sku: row.sku,
        movements: [],
        reconstructedEndingQuantity: 0,
      };
      byVariant.set(row.variant_id, timeline);
    }

    timeline.movements.push({
      variantId: row.variant_id,
      sku: row.sku,
      kind: row.kind,
      effectiveAt: new Date(row.effective_at),
      quantityDelta: delta,
      sourceId: row.source_id,
      sourceDocumentId: row.source_document_id,
    });
    timeline.reconstructedEndingQuantity += delta;
  }

  return byVariant;
}

/**
 * Quantity on hand in the Miami pool immediately BEFORE a given movement,
 * starting from `openingQuantity`. This is what replaces the captured
 * `qty_on_hand_at_receive`: derived from the ledger, and therefore checkable.
 */
export function quantityBefore(
  timeline: VariantTimeline,
  openingQuantity: number,
  sourceId: string
): number | null {
  let running = openingQuantity;
  for (const movement of timeline.movements) {
    if (movement.sourceId === sourceId) return running;
    running += movement.quantityDelta;
  }
  return null;
}

/**
 * The opening quantity at the anchor date, solved BACKWARDS from today's real
 * stock: opening = current - (everything the ledger says happened since).
 *
 * Deriving it forwards is impossible — nobody recorded what was on hand on
 * 2026-04-14. Deriving it backwards means the timeline is guaranteed to land on
 * today's actual `stocked_quantity`, and any error shows up as an implausible
 * opening balance (negative, or wildly off the first receipt) rather than as a
 * silent drift. `residual` carries that check to the reconciliation report.
 */
export function solveOpeningQuantity(
  timeline: VariantTimeline,
  currentQuantity: number
): { openingQuantity: number; residual: number } {
  const netMovement = timeline.reconstructedEndingQuantity;
  const openingQuantity = currentQuantity - netMovement;
  return {
    openingQuantity,
    // Negative opening = the ledger claims more went out than ever came in,
    // which means a movement source is missing. Surfaced, never swallowed.
    residual: openingQuantity < 0 ? openingQuantity : 0,
  };
}
