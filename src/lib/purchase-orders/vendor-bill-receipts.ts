/**
 * vendor-bill-receipts.ts
 *
 * D6 — bill ↔ MANY receipts (docs/VENDOR_BILL_QB_SYNC_PLAN.md §3.0 + §5).
 *
 * Shared dual-read/dual-write helpers for the receipt↔bill binding
 * transition:
 *   - New source of truth: `purchase_order_receipt.vendor_bill_id` (a
 *     receipt belongs to AT MOST one bill).
 *   - Legacy mirror: `vendor_bill.purchase_order_receipt_id` (kept populated
 *     with the FIRST bound receipt, by seq, for readers that haven't
 *     migrated to the receipt SET yet — display-only "primary receipt").
 *
 * Every route that binds/unbinds a receipt to a bill MUST go through
 * `validateReceiptsForBinding` before writing, and call
 * `syncPrimaryReceiptPointer` after writing so the legacy column never goes
 * stale. Every route that needs "which receipts does this bill span" reads
 * via `resolveBoundReceiptIds` (dual-read union) rather than the legacy
 * column alone.
 */

export type RawKnex = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
};

export interface BoundReceiptRow {
  id: string;
  number: string;
  seq: number;
  received_at: string;
  units: number;
}

/**
 * Dual-read union of receipts bound to `billId`: everything with
 * `purchase_order_receipt.vendor_bill_id = billId` PLUS the legacy
 * `legacyReceiptId` (a bill's own `purchase_order_receipt_id`), if any and
 * not already in the set. Order is NOT guaranteed — callers that need
 * chronological order (AVCO replay) must sort by received_at/seq themselves.
 */
export async function resolveBoundReceiptIds(
  db: RawKnex,
  billId: string,
  legacyReceiptId: string | null
): Promise<string[]> {
  const result = await db.raw(
    `SELECT id FROM purchase_order_receipt
      WHERE vendor_bill_id = ? AND deleted_at IS NULL`,
    [billId]
  );
  const ids = new Set(
    (result.rows as Array<{ id: string }>).map((r) => r.id)
  );
  if (legacyReceiptId) ids.add(legacyReceiptId);
  return [...ids];
}

/**
 * Recomputes the legacy `vendor_bill.purchase_order_receipt_id` mirror from
 * the LIVE new-FK-bound set (earliest bound receipt by seq, or NULL if none
 * are bound). Call this after ANY write to `purchase_order_receipt.vendor_bill_id`
 * for a bill, so the legacy "primary receipt" pointer never drifts from the
 * real (dual-write) source of truth.
 */
export async function syncPrimaryReceiptPointer(
  db: RawKnex,
  billId: string
): Promise<void> {
  const result = await db.raw(
    `SELECT id FROM purchase_order_receipt
      WHERE vendor_bill_id = ? AND deleted_at IS NULL
      ORDER BY seq ASC
      LIMIT 1`,
    [billId]
  );
  const primaryId = (result.rows[0] as { id: string } | undefined)?.id ?? null;
  await db.raw(
    `UPDATE vendor_bill SET purchase_order_receipt_id = ?, updated_at = NOW()
      WHERE id = ? AND deleted_at IS NULL`,
    [primaryId, billId]
  );
}

export interface ReceiptLineUnionRow {
  purchase_order_line_id: string;
  product_variant_id: string | null;
  sku: string;
  description: string;
  qty: number;
  unit_cost_cents: number;
  metadata: Record<string, unknown> | null;
}

/**
 * UNION across `receiptIds`: SUM(qty_received_now) per purchase_order_line_id,
 * grouped across every receipt in the set — the D6/D8 "sum quantities across
 * all bound receipts" rule. Shared by `sync-from-source` (source='receipt')
 * and `POST /admin/vendor-bills/from-receipts` (multi-receipt creation) so
 * the two paths can never drift on how a receipt set maps to bill lines.
 * Lines with zero net received qty (fully offset by a later correction) are
 * dropped via HAVING, matching sync-from-source's original behavior.
 */
export async function resolveReceiptLineUnion(
  db: RawKnex,
  receiptIds: string[]
): Promise<ReceiptLineUnionRow[]> {
  const result = await db.raw(
    `SELECT
       porl.purchase_order_line_id,
       porl.product_variant_id,
       MAX(porl.sku_snapshot)         AS sku,
       MAX(porl.description_snapshot) AS description,
       COALESCE(SUM(porl.qty_received_now), 0)::int AS qty,
       COALESCE(
         MAX(porl.unit_cost_cents_override),
         MAX(pol.unit_cost_cents),
         0
       )::int AS unit_cost_cents,
       (array_agg(pv.metadata) FILTER (WHERE pv.metadata IS NOT NULL))[1] AS metadata
     FROM purchase_order_receipt_line porl
     JOIN purchase_order_line pol ON pol.id = porl.purchase_order_line_id
     LEFT JOIN product_variant pv
       ON pv.id = porl.product_variant_id AND pv.deleted_at IS NULL
     WHERE porl.purchase_order_receipt_id = ANY(?) AND porl.deleted_at IS NULL
     GROUP BY porl.purchase_order_line_id, porl.product_variant_id
     HAVING COALESCE(SUM(porl.qty_received_now), 0) > 0`,
    [receiptIds]
  );
  return result.rows as ReceiptLineUnionRow[];
}

export interface ReceiptBindingValidationError {
  status: number;
  body: { error: string; code: string; [key: string]: unknown };
}

export type ReceiptBindingValidationResult =
  | {
      ok: true;
      rows: Array<{
        id: string;
        number: string;
        seq: number;
        received_at: string;
        status: string;
      }>;
    }
  | { ok: false; status: number; body: ReceiptBindingValidationError["body"] };

/**
 * Validates a set of receipt ids being bound to `billId` on `purchaseOrderId`:
 *   - every id must exist (404 receipt_not_found)
 *   - every receipt must belong to the same PO (409 receipt_po_mismatch)
 *   - every receipt must be applied/synced (409 receipt_not_applied)
 *   - no receipt may already be bound to a DIFFERENT bill — checked via
 *     dual-read (the new FK OR the legacy pointer) — (409 receipt_already_billed)
 *
 * A receipt already bound to `billId` itself is a no-op pass (idempotent —
 * confirming/re-binding an already-bound receipt is fine).
 */
export async function validateReceiptsForBinding(
  db: RawKnex,
  opts: { purchaseOrderId: string; billId: string; receiptIds: string[] }
): Promise<ReceiptBindingValidationResult> {
  const { purchaseOrderId, billId, receiptIds } = opts;
  const uniqueIds = [...new Set(receiptIds)];
  if (uniqueIds.length === 0) {
    return { ok: true, rows: [] };
  }

  const result = await db.raw(
    `SELECT por.id, por.number, por.seq, por.received_at, por.status,
            por.purchase_order_id,
            fk_vb.id           AS fk_bill_id,
            fk_vb.number       AS fk_bill_number,
            legacy_vb.id       AS legacy_bill_id,
            legacy_vb.number   AS legacy_bill_number
       FROM purchase_order_receipt por
       LEFT JOIN vendor_bill fk_vb
         ON fk_vb.id = por.vendor_bill_id AND fk_vb.deleted_at IS NULL
       LEFT JOIN vendor_bill legacy_vb
         ON legacy_vb.purchase_order_receipt_id = por.id AND legacy_vb.deleted_at IS NULL
      WHERE por.id = ANY(?) AND por.deleted_at IS NULL`,
    [uniqueIds]
  );

  type Row = {
    id: string;
    number: string;
    seq: number;
    received_at: string;
    status: string;
    purchase_order_id: string;
    fk_bill_id: string | null;
    fk_bill_number: string | null;
    legacy_bill_id: string | null;
    legacy_bill_number: string | null;
  };
  const rows = result.rows as Row[];
  const byId = new Map(rows.map((r) => [r.id, r]));

  for (const rid of uniqueIds) {
    const row = byId.get(rid);
    if (!row) {
      return {
        ok: false,
        status: 404,
        body: { error: `Receipt ${rid} not found`, code: "receipt_not_found", receipt_id: rid },
      };
    }
    if (row.purchase_order_id !== purchaseOrderId) {
      return {
        ok: false,
        status: 409,
        body: {
          error: `Receipt ${row.number} does not belong to this bill's purchase order`,
          code: "receipt_po_mismatch",
          receipt_id: rid,
        },
      };
    }
    if (row.status !== "applied" && row.status !== "synced") {
      return {
        ok: false,
        status: 409,
        body: {
          error: `Receipt ${row.number} is not applied yet`,
          code: "receipt_not_applied",
          receipt_id: rid,
        },
      };
    }

    const otherBill =
      row.fk_bill_id && row.fk_bill_id !== billId
        ? { id: row.fk_bill_id, number: row.fk_bill_number }
        : row.legacy_bill_id && row.legacy_bill_id !== billId
          ? { id: row.legacy_bill_id, number: row.legacy_bill_number }
          : null;
    if (otherBill) {
      return {
        ok: false,
        status: 409,
        body: {
          error: `Receipt ${row.number} is already billed on ${otherBill.number ?? otherBill.id}`,
          code: "receipt_already_billed",
          receipt_id: rid,
          other_bill_id: otherBill.id,
          other_bill_number: otherBill.number,
        },
      };
    }
  }

  return {
    ok: true,
    rows: uniqueIds.map((rid) => {
      const r = byId.get(rid)!;
      return {
        id: r.id,
        number: r.number,
        seq: r.seq,
        received_at: r.received_at,
        status: r.status,
      };
    }),
  };
}
