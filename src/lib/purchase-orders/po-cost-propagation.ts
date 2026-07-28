/**
 * src/lib/purchase-orders/po-cost-propagation.ts
 *
 * Vendor Bill → Purchase Order unit-cost propagation.
 *
 * The vendor's invoice is the authoritative price document: when the operator
 * corrects a unit cost on the bill, the PO it was raised from must carry the
 * same number, otherwise the drift engine (lib/china-finance/bill-drift.ts)
 * reports a permanent mismatch against a bill that is, in fact, right.
 *
 * Two effects, in this order:
 *   1. `purchase_order_line.unit_cost_cents` (+ its `total_cents`) and the PO
 *      header's subtotal/total are rewritten from the bill's numbers.
 *   2. If the PO is already in QuickBooks, a `purchase_order_mod` is appended
 *      to the PO's dependency chain so QB shows the same cost. The chain
 *      (`enqueuePurchaseQbOperation`) serializes it AFTER any BillMod this
 *      same save enqueued — the Bill Mod → PO Mod ordering the plan requires
 *      falls out of the chain, it is not re-implemented here.
 *
 * Quantities are never touched: `qty billed ≤ qty received ≤ qty ordered`
 * stays whatever the PO already said.
 *
 * NOTE — the PATCH /admin/purchase-orders/:id route has its own inline copy of
 * the PurchaseOrderMod payload builder. It is deliberately NOT shared: that
 * route sends the PRE-update header snapshot (`existing`) while this path must
 * send what the tables say right now. Keep the `lines` shape in sync with it.
 */

import { randomUUID } from "crypto";

import { orderPurchaseOrderModLines } from "../quickbooks/purchase-order-line-order";
import {
  enqueuePurchaseQbOperation,
  purchaseOperationKey,
  type PurchaseDependencyKnex,
} from "./qb-purchase-dependency-chain";

/** PO lifecycle states whose QuickBooks document still accepts a Mod. */
const QB_MODDABLE_STATUSES = new Set([
  "submitted",
  "partially_received",
  "received",
]);

/** Local cost writes are refused once the PO is terminal. */
const LOCALLY_FROZEN_STATUSES = new Set(["cancelled", "voided", "closed"]);

export interface PoLineCostChange {
  purchase_order_line_id: string;
  unit_cost_cents: number;
}

export interface PoCostPropagationResult {
  /** PO line ids whose unit cost actually moved. */
  updated_line_ids: string[];
  /** True when a PurchaseOrderMod was appended to the PO's QB chain. */
  qb_mod_enqueued: boolean;
  /** Set when the PO could not take the new cost (terminal status, etc.). */
  skipped_reason: string | null;
}

export interface BillLineCostInput {
  /** Bill line id; absent on a line being inserted by this same save. */
  id?: string;
  purchase_order_line_id: string;
  unit_cost_cents: number;
}

/**
 * Which PO lines a staged bill-line set should reprice.
 *
 * Only lines whose cost actually MOVED count — a save that merely re-sends the
 * same numbers must not queue a QuickBooks Mod. Newly inserted bill lines have
 * no "before" to compare against, so they never reprice the PO either: adding a
 * line is not a price correction.
 *
 * Ambiguity is skipped, not guessed: when several bill lines cover the SAME PO
 * line at DIFFERENT costs (a split shipment priced apart), there is no single
 * number to push, so the PO keeps its own.
 */
export function resolvePoCostChanges(
  billLines: readonly BillLineCostInput[],
  previousCostByLineId: ReadonlyMap<string, number>
): PoLineCostChange[] {
  const byPoLine = new Map<string, Set<number>>();
  for (const line of billLines) {
    const previous = line.id ? previousCostByLineId.get(line.id) : undefined;
    if (previous === undefined || previous === line.unit_cost_cents) continue;
    const bucket = byPoLine.get(line.purchase_order_line_id) ?? new Set<number>();
    bucket.add(line.unit_cost_cents);
    byPoLine.set(line.purchase_order_line_id, bucket);
  }
  const changes: PoLineCostChange[] = [];
  for (const [purchase_order_line_id, costs] of byPoLine) {
    if (costs.size !== 1) continue;
    changes.push({ purchase_order_line_id, unit_cost_cents: [...costs][0]! });
  }
  return changes;
}

function num(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function poMemoNumber(poNumber: string): string {
  return poNumber.startsWith("PO-") ? poNumber.slice(3) : poNumber;
}

interface PoHeaderRow {
  id: string;
  number: string | null;
  status: string;
  vendor_id: string | null;
  vendor_name_snapshot: string | null;
  vendor_qb_list_id_snapshot: string | null;
  ordered_at: string | Date | null;
  expected_at: string | Date | null;
  reference_number: string | null;
  tax_cents: number | string | null;
  shipping_cents: number | string | null;
  other_fees_cents: number | string | null;
  qb_purchase_order_list_id: string | null;
  qb_edit_sequence: string | null;
}

interface PoLineRow {
  id: string;
  qty_ordered: number | string;
  unit_cost_cents: number | string;
  tax_cents: number | string | null;
  sku_snapshot: string;
  description_snapshot: string;
  qb_item_list_id_snapshot: string | null;
  qb_txn_line_id: string | null;
  line_order: number | string | null;
}

/**
 * Applies `changes` to the PO's lines and, when the PO lives in QuickBooks,
 * queues the matching PurchaseOrderMod. Safe to call with changes that match
 * what the PO already says — those are filtered out and the whole call becomes
 * a no-op (no header rewrite, no QB traffic).
 *
 * `db` must be the same transaction the caller is using for the bill edit, so
 * a rolled-back bill save never leaves a repriced PO behind.
 */
export async function propagateUnitCostsToPurchaseOrder(
  db: PurchaseDependencyKnex,
  purchaseOrderId: string,
  changes: PoLineCostChange[]
): Promise<PoCostPropagationResult> {
  const empty: PoCostPropagationResult = {
    updated_line_ids: [],
    qb_mod_enqueued: false,
    skipped_reason: null,
  };
  if (changes.length === 0) return empty;

  const headerResult = await db.raw(
    `SELECT id, number, status, vendor_id, vendor_name_snapshot,
            vendor_qb_list_id_snapshot, ordered_at, expected_at, reference_number,
            tax_cents, shipping_cents, other_fees_cents,
            qb_purchase_order_list_id, qb_edit_sequence
       FROM purchase_order
      WHERE id = ? AND deleted_at IS NULL`,
    [purchaseOrderId]
  );
  const header = headerResult.rows[0] as PoHeaderRow | undefined;
  if (!header) return { ...empty, skipped_reason: "purchase_order_not_found" };
  if (LOCALLY_FROZEN_STATUSES.has(header.status)) {
    return { ...empty, skipped_reason: `purchase_order_${header.status}` };
  }

  const wantedById = new Map(
    changes.map((c) => [c.purchase_order_line_id, Math.round(c.unit_cost_cents)])
  );
  const lineIds = [...wantedById.keys()];
  const linesResult = await db.raw(
    `SELECT id, qty_ordered, unit_cost_cents, tax_cents
       FROM purchase_order_line
      WHERE purchase_order_id = ? AND id = ANY(?) AND deleted_at IS NULL`,
    [purchaseOrderId, lineIds]
  );
  const targets = linesResult.rows as Array<
    Pick<PoLineRow, "id" | "qty_ordered" | "unit_cost_cents" | "tax_cents">
  >;

  const updated: string[] = [];
  for (const line of targets) {
    const next = wantedById.get(line.id);
    if (next === undefined || next === num(line.unit_cost_cents)) continue;
    // Mirrors _lib/totals.ts normalizeLine: total = round(qty × unit) + tax.
    const total = Math.round(num(line.qty_ordered) * next) + num(line.tax_cents);
    await db.raw(
      `UPDATE purchase_order_line
          SET unit_cost_cents = ?, total_cents = ?, updated_at = NOW()
        WHERE id = ? AND purchase_order_id = ? AND deleted_at IS NULL`,
      [next, total, line.id, purchaseOrderId]
    );
    updated.push(line.id);
  }
  if (updated.length === 0) return empty;

  // Header totals. `purchase_order.tax_cents` already holds header tax + line
  // tax combined (computeTotals), and no tax moved here, so it is carried
  // through untouched — recomputing it from the lines would double-count.
  await db.raw(
    `UPDATE purchase_order AS po
        SET subtotal_cents = agg.s,
            total_cents = agg.s + COALESCE(po.tax_cents, 0)
                          + COALESCE(po.shipping_cents, 0)
                          + COALESCE(po.other_fees_cents, 0),
            updated_at = NOW()
       FROM (
         SELECT COALESCE(SUM(total_cents - COALESCE(tax_cents, 0)), 0) AS s
           FROM purchase_order_line
          WHERE purchase_order_id = ? AND deleted_at IS NULL
       ) AS agg
      WHERE po.id = ?`,
    [purchaseOrderId, purchaseOrderId]
  );

  if (
    !header.qb_purchase_order_list_id ||
    !QB_MODDABLE_STATUSES.has(header.status)
  ) {
    return { updated_line_ids: updated, qb_mod_enqueued: false, skipped_reason: null };
  }

  const freshLinesResult = await db.raw(
    `SELECT id, qty_ordered, unit_cost_cents, tax_cents, sku_snapshot,
            description_snapshot, qb_item_list_id_snapshot, qb_txn_line_id, line_order
       FROM purchase_order_line
      WHERE purchase_order_id = ? AND deleted_at IS NULL
      ORDER BY line_order ASC NULLS LAST, created_at ASC`,
    [purchaseOrderId]
  );
  const freshLines = (freshLinesResult.rows as PoLineRow[]).map((l) => ({
    id: l.id,
    sku_snapshot: l.sku_snapshot,
    description_snapshot: l.description_snapshot,
    qty_ordered: num(l.qty_ordered),
    unit_cost_cents: num(l.unit_cost_cents),
    qb_item_list_id_snapshot: l.qb_item_list_id_snapshot,
    qb_txn_line_id: l.qb_txn_line_id,
  }));

  const modPayload = {
    is_mod: true,
    delegated_to_consolidator: true,
    operation_revision: randomUUID(),
    txn_id: header.qb_purchase_order_list_id,
    edit_sequence: header.qb_edit_sequence ?? undefined,
    po_id: purchaseOrderId,
    po_number: header.number ?? undefined,
    vendor_qb_list_id: header.vendor_qb_list_id_snapshot ?? null,
    vendor_name: header.vendor_name_snapshot ?? header.vendor_id,
    ordered_at: header.ordered_at ? new Date(header.ordered_at).toISOString() : null,
    expected_at: header.expected_at ? new Date(header.expected_at).toISOString() : null,
    memo: `Medusa PO ${poMemoNumber(header.number ?? purchaseOrderId)}`,
    reference_number: header.reference_number ?? null,
    lines: orderPurchaseOrderModLines(freshLines).map((l) => ({
      line_id: l.id,
      qb_txn_line_id: l.qb_txn_line_id ?? null,
      qb_item_list_id: l.qb_item_list_id_snapshot,
      sku: l.sku_snapshot,
      description: l.description_snapshot,
      qty_ordered: l.qty_ordered,
      unit_cost_cents: l.unit_cost_cents,
    })),
  };

  // The legacy per-PO pipeline row is the operator-facing record; reset it to
  // waiting (UPDATE-first, INSERT-fallback — the table has one row per PO and
  // re-INSERTing violates its uniqueness).
  const resetResult = await db.raw(
    `UPDATE qb_purchase_order_pipeline
        SET status          = 'waiting',
            qb_operation_id = NULL,
            payload         = ?,
            retries         = 0,
            last_error      = NULL,
            next_retry_at   = NULL,
            synced_at       = NULL,
            updated_at      = NOW()
      WHERE purchase_order_id = ? AND deleted_at IS NULL`,
    [JSON.stringify(modPayload), purchaseOrderId]
  );
  let legacyPipelineId: string;
  if ((resetResult.rowCount ?? 0) === 0) {
    legacyPipelineId = `qbpopipe_${randomUUID().replace(/-/g, "")}`;
    await db.raw(
      `INSERT INTO qb_purchase_order_pipeline
         (id, purchase_order_id, status, payload, retries, created_at, updated_at)
       VALUES (?, ?, 'waiting', ?, 0, NOW(), NOW())`,
      [legacyPipelineId, purchaseOrderId, JSON.stringify(modPayload)]
    );
  } else {
    const idResult = await db.raw(
      `SELECT id FROM qb_purchase_order_pipeline
        WHERE purchase_order_id = ? AND deleted_at IS NULL
        LIMIT 1`,
      [purchaseOrderId]
    );
    legacyPipelineId = String(
      (idResult.rows[0] as { id: string } | undefined)?.id ?? ""
    );
    if (!legacyPipelineId) {
      throw new Error("Purchase Order pipeline row could not be resolved");
    }
  }

  const orderPayload = {
    ...modPayload,
    qb_purchase_order_pipeline_id: legacyPipelineId,
  };
  const operation = await enqueuePurchaseQbOperation(db, {
    purchaseOrderId,
    referenceId: purchaseOrderId,
    referenceType: "purchase_order",
    step: "purchase_order_mod",
    qbTxnId: header.qb_purchase_order_list_id,
    payload: orderPayload,
    operationKey: purchaseOperationKey(
      "purchase_order_mod",
      purchaseOrderId,
      orderPayload
    ),
  });
  await db.raw(
    `UPDATE qb_purchase_order_pipeline
        SET order_pipeline_id = ?, updated_at = NOW()
      WHERE id = ?`,
    [operation.id, legacyPipelineId]
  );

  return { updated_line_ids: updated, qb_mod_enqueued: true, skipped_reason: null };
}
