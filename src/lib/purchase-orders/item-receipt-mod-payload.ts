/**
 * src/lib/purchase-orders/item-receipt-mod-payload.ts
 *
 * Shared building blocks for QuickBooks ItemReceiptMod enqueue + drift
 * detection. Extracted so a SINGLE payload-build lives behind:
 *   - the workflow step `enqueue-qb-item-receipt-mod-step.ts` (user edits)
 *   - the poller's reconcile-on-confirm (edits that landed while the ADD was
 *     in-flight — the root cause of the RCP-1134 / PO-1081 3060 incident)
 *   - the drift-detector cron (read-only backstop)
 *   - the one-off repair script `scripts/fix/repair-diverged-item-receipts.ts`
 *
 * WHY: the ItemReceipt ADD payload is frozen at receipt-creation time. Editing
 * a receipt line while its ADD is still `waiting`/`submitted` (no
 * qb_item_receipt_list_id yet) mutates Medusa but never refreshes the frozen
 * ADD payload and cannot enqueue a Mod (the enqueue guard requires the ADD to
 * be synced). The stale ADD ships the pre-edit qty to QB → permanent divergence
 * (Medusa != QB), and a later PO Mod fails QB Error 3060.
 *
 * The Mod payload is rehydrated FROM CURRENT DB STATE (never a delta). The
 * bridge's ItemReceiptMod REPLACES all lines, so the payload carries the full
 * final shape; a line with qty 0 is OMITTED → QB deletes it and reopens the PO
 * qty. Each retained line carries its qb_po_txn_line_id so <LinkToTxn> is
 * re-emitted and the PO↔Receipt linkage is preserved.
 */

export type KnexRaw = {
  raw: (
    sql: string,
    bindings?: unknown[]
  ) => Promise<{ rows: unknown[]; rowCount?: number }>;
};

export interface ItemReceiptModPayloadLine {
  receipt_line_id: string;
  po_line_id: string;
  qb_item_list_id: string;
  qb_po_txn_line_id: string | null;
  sku: string;
  description: string;
  qty_received_now: number;
  unit_cost_cents: number;
}

export interface ItemReceiptModPayload {
  txn_id: string;
  edit_sequence: string | null;
  po_id: string;
  po_number: string;
  receipt_id: string;
  receipt_number: string;
  vendor_qb_list_id: string;
  vendor_name: string;
  qb_po_list_id: string | null;
  inventory_site_list_id: string | null;
  received_at: string;
  vendor_bill_number: string | null;
  vendor_bill_date: string | null;
  memo: string | null;
  lines: ItemReceiptModPayloadLine[];
}

export type BuildModPayloadResult =
  | { ok: true; payload: ItemReceiptModPayload; pipeline_id: string }
  | { ok: false; reason: string };

/**
 * Builds the ItemReceiptMod payload from the receipt's CURRENT live state.
 * Returns `{ ok: false, reason }` instead of throwing so drift/reconcile
 * callers can skip gracefully; the workflow step wraps this and throws.
 *
 * Guards (must all pass): pipeline row exists & status='synced', no active
 * void, no in-flight Mod, receipt has a QB TxnID, at least one qty>0 line.
 */
export async function buildItemReceiptModPayload(
  knex: KnexRaw,
  receiptId: string
): Promise<BuildModPayloadResult> {
  const headerRows = await knex.raw(
    `SELECT
       r.id                              AS receipt_id,
       r.number                          AS receipt_number,
       r.purchase_order_id               AS po_id,
       r.qb_item_receipt_list_id         AS txn_id,
       r.qb_edit_sequence,
       r.received_at,
       r.vendor_bill_number,
       r.vendor_bill_date,
       po.number                         AS po_number,
       po.vendor_qb_list_id_snapshot     AS vendor_qb_list_id,
       po.vendor_name_snapshot           AS vendor_name,
       po.qb_purchase_order_list_id      AS qb_po_list_id,
       po.memo                           AS memo,
       pipe.id                           AS pipeline_id,
       pipe.status                       AS pipe_status,
       pipe.void_status                  AS pipe_void_status,
       pipe.mod_status                   AS pipe_mod_status
     FROM purchase_order_receipt r
     JOIN purchase_order po
       ON po.id = r.purchase_order_id
     JOIN qb_item_receipt_pipeline pipe
       ON pipe.purchase_order_receipt_id = r.id
     WHERE r.id = ?
       AND pipe.deleted_at IS NULL`,
    [receiptId]
  );
  const header = (headerRows.rows?.[0] ?? null) as Record<string, unknown> | null;
  if (!header) {
    return { ok: false, reason: `receipt ${receiptId} or its pipeline row not found` };
  }

  if (header.pipe_status !== "synced") {
    return {
      ok: false,
      reason: `pipeline status is '${String(header.pipe_status)}', expected 'synced'`,
    };
  }
  const voidStatus = header.pipe_void_status as string | null;
  if (voidStatus && voidStatus !== "completed" && voidStatus !== "failed_permanent") {
    return { ok: false, reason: `receipt has void_status='${voidStatus}' — mid-void` };
  }
  const modStatus = header.pipe_mod_status as string | null;
  if (modStatus === "waiting" || modStatus === "submitted" || modStatus === "error") {
    return { ok: false, reason: `receipt already has mod_status='${modStatus}'` };
  }
  if (!header.txn_id) {
    return { ok: false, reason: `receipt has no qb_item_receipt_list_id (TxnID)` };
  }

  const lineRows = await knex.raw(
    `SELECT
       rl.id                            AS receipt_line_id,
       rl.purchase_order_line_id        AS po_line_id,
       rl.qb_item_list_id_snapshot      AS qb_item_list_id,
       rl.sku_snapshot                  AS sku,
       rl.description_snapshot          AS description,
       rl.qty_received_now              AS qty_received_now,
       COALESCE(rl.unit_cost_cents_override, pol.unit_cost_cents)
                                        AS unit_cost_cents,
       pol.qb_txn_line_id               AS qb_po_txn_line_id
     FROM purchase_order_receipt_line rl
     JOIN purchase_order_line pol
       ON pol.id = rl.purchase_order_line_id
     WHERE rl.purchase_order_receipt_id = ?
       AND rl.deleted_at IS NULL
       AND rl.qty_received_now > 0
     ORDER BY rl.id ASC`,
    [receiptId]
  );
  const lines = (lineRows.rows ?? []) as Record<string, unknown>[];
  if (lines.length === 0) {
    return { ok: false, reason: `receipt ${receiptId} has no qty>0 lines to send` };
  }

  const payload: ItemReceiptModPayload = {
    txn_id: String(header.txn_id),
    edit_sequence: (header.qb_edit_sequence as string | null) ?? null,
    po_id: String(header.po_id),
    po_number: String(header.po_number),
    receipt_id: String(header.receipt_id),
    receipt_number: String(header.receipt_number),
    vendor_qb_list_id: String(header.vendor_qb_list_id),
    vendor_name: String(header.vendor_name),
    qb_po_list_id: (header.qb_po_list_id as string | null) ?? null,
    inventory_site_list_id: null,
    received_at: new Date(header.received_at as string).toISOString(),
    vendor_bill_number: (header.vendor_bill_number as string | null) ?? null,
    vendor_bill_date: header.vendor_bill_date
      ? new Date(header.vendor_bill_date as string).toISOString()
      : null,
    memo: (header.memo as string | null) ?? null,
    lines: lines.map((l) => ({
      receipt_line_id: String(l.receipt_line_id),
      po_line_id: String(l.po_line_id),
      qb_item_list_id: String(l.qb_item_list_id ?? ""),
      qb_po_txn_line_id: l.qb_po_txn_line_id ? String(l.qb_po_txn_line_id) : null,
      sku: String(l.sku ?? ""),
      description: String(l.description ?? ""),
      qty_received_now: Number(l.qty_received_now),
      unit_cost_cents: Number(l.unit_cost_cents),
    })),
  };

  return { ok: true, payload, pipeline_id: String(header.pipeline_id) };
}

/**
 * Atomically enqueues a Mod. The WHERE clause is the concurrency gate: it only
 * flips a row whose ADD is synced (qb_list_id present) and which is NOT already
 * mid-Mod (waiting/submitted). This prevents a reconcile pass from clobbering a
 * concurrent user-driven Mod enqueue. Returns true if a row was claimed.
 *
 * NOTE: 'error' is intentionally overwritable here (a stuck error row should
 * accept a freshly-rehydrated payload); the workflow step's own guard already
 * blocks user edits while mod_status='error'.
 */
export async function enqueueItemReceiptModAtomic(
  knex: KnexRaw,
  pipelineId: string,
  payload: ItemReceiptModPayload
): Promise<boolean> {
  const res = await knex.raw(
    `UPDATE qb_item_receipt_pipeline
        SET mod_status        = 'waiting',
            mod_payload       = ?::jsonb,
            mod_operation_id  = NULL,
            mod_retries       = 0,
            mod_last_error    = NULL,
            mod_next_retry_at = NULL,
            mod_synced_at     = NULL,
            updated_at        = NOW()
      WHERE id = ?
        AND qb_list_id IS NOT NULL
        AND COALESCE(mod_status, '') NOT IN ('waiting', 'submitted')`,
    [JSON.stringify(payload), pipelineId]
  );
  return (res.rowCount ?? 0) > 0;
}

export interface ReceiptDriftLine {
  receipt_line_id: string;
  sku: string;
  qb_qty: number;
  live_qty: number;
}

export interface ReceiptDrift {
  receipt_id: string;
  receipt_number: string;
  pipeline_id: string;
  lines: ReceiptDriftLine[];
}

/**
 * Read-only drift scan: compares the qty QB currently holds (mod_payload if a
 * Mod completed, else the frozen ADD payload) against the live receipt line
 * qty, for every synced, non-voided receipt with no in-flight Mod. This is the
 * backstop the RCP-1134/RCP-1071 class of silent divergence needs.
 *
 * Only QUANTITY drift is reported — unit-cost drift is deliberately excluded
 * (changing cost on a QB receipt has accounting side effects once a vendor
 * bill / AVCO has consumed it; cost corrections stay a manual decision).
 */
export async function computeReceiptDrift(
  knex: KnexRaw,
  receiptNumbers?: string[]
): Promise<ReceiptDrift[]> {
  const filter = receiptNumbers && receiptNumbers.length > 0;
  const rows = await knex.raw(
    `WITH eff AS (
       SELECT p.id AS pipeline_id,
              p.purchase_order_receipt_id AS receipt_id,
              pr.number AS receipt_number,
              CASE WHEN p.mod_status = 'completed' THEN p.mod_payload ELSE p.payload END AS qb_payload
       FROM qb_item_receipt_pipeline p
       JOIN purchase_order_receipt pr ON pr.id = p.purchase_order_receipt_id
       WHERE p.status = 'synced'
         AND p.void_status IS NULL
         AND p.deleted_at IS NULL
         AND COALESCE(p.mod_status, '') NOT IN ('waiting', 'submitted', 'error')
         AND pr.voided_at IS NULL
         ${filter ? "AND pr.number = ANY(?)" : ""}
     ),
     qbl AS (
       SELECT eff.pipeline_id, eff.receipt_id, eff.receipt_number,
              (l->>'receipt_line_id') AS receipt_line_id,
              (l->>'sku') AS sku,
              (l->>'qty_received_now')::numeric AS qb_qty
       FROM eff, jsonb_array_elements(eff.qb_payload->'lines') l
     )
     SELECT qbl.pipeline_id, qbl.receipt_id, qbl.receipt_number,
            qbl.receipt_line_id, qbl.sku, qbl.qb_qty,
            rl.qty_received_now::numeric AS live_qty
     FROM qbl
     JOIN purchase_order_receipt_line rl
       ON rl.id = qbl.receipt_line_id AND rl.deleted_at IS NULL
     WHERE rl.qty_received_now::numeric <> qbl.qb_qty
     ORDER BY qbl.receipt_number, qbl.sku`,
    filter ? [receiptNumbers] : []
  );

  const byReceipt = new Map<string, ReceiptDrift>();
  for (const r of (rows.rows ?? []) as Record<string, unknown>[]) {
    const rid = String(r.receipt_id);
    if (!byReceipt.has(rid)) {
      byReceipt.set(rid, {
        receipt_id: rid,
        receipt_number: String(r.receipt_number),
        pipeline_id: String(r.pipeline_id),
        lines: [],
      });
    }
    byReceipt.get(rid)!.lines.push({
      receipt_line_id: String(r.receipt_line_id),
      sku: String(r.sku),
      qb_qty: Number(r.qb_qty),
      live_qty: Number(r.live_qty),
    });
  }
  return [...byReceipt.values()];
}

export interface ReconcileResult {
  enqueued: boolean;
  driftedSkus: string[];
  reason?: string;
}

/**
 * RECONCILE-ON-CONFIRM. Called by the item-receipt poller right after an ADD
 * confirms in QB (list_id + edit_sequence just written). If a receipt line was
 * edited while the ADD was still in-flight, the frozen ADD payload shipped the
 * pre-edit qty and QB now diverges from the live receipt. This detects that
 * QUANTITY drift and auto-enqueues a corrective Mod (rehydrated from live state)
 * behind the atomic mod-enqueue gate — closing the RM5 / PO-1081 class of silent
 * divergence going forward, without a periodic writer that could loop.
 *
 * QTY-only trigger: unit-cost drift alone does NOT auto-Mod (changing cost on a
 * QB receipt has accounting side effects once a bill/AVCO consumed it). Any Mod
 * enqueued here still rehydrates the live cost, but only qty drift triggers it.
 *
 * Idempotent: the atomic gate refuses if a Mod is already waiting/submitted (a
 * concurrent user edit wins). Safe to call unconditionally at confirm time.
 */
export async function reconcileReceiptModIfDrifted(
  knex: KnexRaw,
  receiptId: string
): Promise<ReconcileResult> {
  const driftRows = await knex.raw(
    `WITH eff AS (
       SELECT p.id AS pipeline_id,
              CASE WHEN p.mod_status = 'completed' THEN p.mod_payload ELSE p.payload END AS qb_payload
       FROM qb_item_receipt_pipeline p
       WHERE p.purchase_order_receipt_id = ?
         AND p.status = 'synced'
         AND p.void_status IS NULL
         AND p.deleted_at IS NULL
         AND COALESCE(p.mod_status, '') NOT IN ('waiting', 'submitted', 'error')
     ),
     qbl AS (
       SELECT (l->>'receipt_line_id') AS receipt_line_id,
              (l->>'sku') AS sku,
              (l->>'qty_received_now')::numeric AS qb_qty
       FROM eff, jsonb_array_elements(eff.qb_payload->'lines') l
     )
     SELECT qbl.sku, qbl.qb_qty, rl.qty_received_now::numeric AS live_qty
     FROM qbl
     JOIN purchase_order_receipt_line rl
       ON rl.id = qbl.receipt_line_id AND rl.deleted_at IS NULL
     WHERE rl.qty_received_now::numeric <> qbl.qb_qty`,
    [receiptId]
  );
  const drifted = (driftRows.rows ?? []) as { sku: string }[];
  if (drifted.length === 0) return { enqueued: false, driftedSkus: [] };

  const driftedSkus = drifted.map((d) => String(d.sku));

  const built = await buildItemReceiptModPayload(knex, receiptId);
  if (!built.ok) return { enqueued: false, driftedSkus, reason: built.reason };

  const enqueued = await enqueueItemReceiptModAtomic(
    knex,
    built.pipeline_id,
    built.payload
  );
  return {
    enqueued,
    driftedSkus,
    reason: enqueued ? undefined : "atomic gate rejected (mod already in flight)",
  };
}
