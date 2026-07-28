/**
 * src/lib/purchase-orders/qb-vendor-bill-enqueue.ts
 *
 * Phase 1.1 (docs/VENDOR_BILL_QB_SYNC_PLAN.md §5): freezes a confirmed
 * REGULAR vendor bill into a `qb_vendor_bill_pipeline` ADD row for the
 * qb-vendor-bill-poller to dispatch as a QuickBooks `BillAdd`.
 *
 * Rules:
 *  - Called AFTER the local confirm (VB number, landed lock, AVCO) committed —
 *    non-fatal by contract: a failed enqueue must never un-confirm the bill
 *    (callers wrap in try/catch; the drift/digest tooling surfaces gaps).
 *  - Fires ONLY when `QB_VENDOR_BILL_MODE === 'bill'` — while the flag is off
 *    NOTHING is queued (deliberate: pre-flip confirms must not accumulate
 *    waiting rows that would all dispatch the moment the flag flips).
 *  - Phase 1 scope is LOCAL vendors: bills whose PO vendor is a China
 *    purchasing agent (`qb_vendor.metadata.is_china_agent`, read LIVE per the
 *    2026-07-06 rule) are SKIPPED — their 4-bill negative-clearing structure
 *    ships in Phase 2.
 *  - One row per bill (UPDATE-first, INSERT-fallback — 2026-07-15 rule); a
 *    re-confirm after reopen reuses the row, bumping nothing: the poller's
 *    object-state gate refuses a second BillAdd for a generation whose
 *    qb_txn_id is already recorded.
 *
 * Payload contract — must match the poller (`qb-vendor-bill-poller.ts`) and
 * the bridge builder (`quickbooks-bridge/src/qbxml/builders/bill.ts`):
 *   item_lines[]:  PO-linked goods (LinkToTxn via po_txn_id + per-line
 *                  qb_po_txn_line_id; qb_item_list_id kept as the standalone
 *                  fallback for lines whose PO line id is still unknown —
 *                  the poller re-reads null ids pre-dispatch).
 *                  Local bills carry the RAW goods unit cost (plan §A.4:
 *                  no negative clearing — freight is a separate positive
 *                  ExpenseLine, never folded into the item cost).
 *   expense_lines[]: the bill's non-item charges as positive ExpenseLines —
 *                  freight_charge lines, qb_account lines, and the header
 *                  sales tax. QBXML BillAdd has NO header tax field (its only
 *                  slots are ExpenseLineAdd / ItemLineAdd), so vendor-charged
 *                  sales tax rides as its own ExpenseLine against a COGS
 *                  account. Whatever is emitted here MUST be the same set the
 *                  Mod path retains (qb-vendor-bill-mod-enqueue.ts) — a line
 *                  the Add creates but the Mod omits is DELETED BY OMISSION
 *                  the first time the bill is edited.
 */

import {
  enqueuePurchaseQbOperation,
  purchaseOperationKey,
} from "./qb-purchase-dependency-chain";
import { allocateLineTotalsCents } from "./landed-allocation";

export type EnqueueKnex = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number }>;
};

export type EnqueueResult =
  | { queued: true; pipelineRowId: string }
  | { queued: false; reason: string };

interface BillRow {
  id: string;
  number: string | null;
  reference_id: string | null;
  document_date: string | null;
  due_date: string | null;
  purchase_order_id: string | null;
  vendor_qb_list_id_snapshot: string | null;
  vendor_name_snapshot: string | null;
  qb_source: string | null;
  rebuild_generation: number;
  tax_amount_cents: number | string | null;
  tax_account_list_id: string | null;
}

interface PoRow {
  number: string | null;
  qb_purchase_order_list_id: string | null;
  vendor_id: string | null;
}

interface LineRow {
  id: string;
  line_kind: string | null;
  line_type: string | null;
  sku: string | null;
  description: string | null;
  qty: number;
  unit_cost_cents: number;
  amount_cents: number | null;
  freight_account_list_id: string | null;
  qb_account_list_id: string | null;
  purchase_order_line_id: string | null;
  qb_po_txn_line_id: string | null;
  variant_qb_item_list_id: string | null;
}

export async function enqueueQbVendorBillAdd(
  knex: EnqueueKnex,
  vendorBillId: string
): Promise<EnqueueResult> {
  if (process.env.QB_VENDOR_BILL_MODE !== "bill") {
    return { queued: false, reason: "QB_VENDOR_BILL_MODE is not 'bill' (flag off)" };
  }

  const billResult = await knex.raw(
    `SELECT vb.id, vb.number, vb.reference_id, vb.document_date, vb.due_date,
            vb.purchase_order_id, vb.vendor_qb_list_id_snapshot,
            vb.vendor_name_snapshot, vb.qb_source,
            vb.tax_amount_cents, vb.tax_account_list_id,
            COALESCE(qvb.rebuild_generation, 0)::int AS rebuild_generation
       FROM vendor_bill vb
       LEFT JOIN qb_vendor_bill_pipeline qvb
         ON qvb.vendor_bill_id = vb.id AND qvb.deleted_at IS NULL
      WHERE vb.id = ? AND vb.deleted_at IS NULL
        AND vb.bill_type = 'regular'`,
    [vendorBillId]
  );
  const bill = (billResult.rows[0] ?? null) as BillRow | null;
  if (!bill) return { queued: false, reason: "bill not found or not regular" };
  // Fail-closed fence (durable invariant): an ADOPTED bill mirrors a QB bill
  // that already exists in QuickBooks — it must NEVER be (re)dispatched to QB,
  // even if some future caller reaches enqueue on one. Adopted bills (both the
  // legacy zero-line imports and the new "Full match" line-level mirrors) are
  // read-only w.r.t. the QB pipeline. See qb-vendor-bill-unlock.ts / PATCH /
  // bill-drift.ts for the sibling guards (owner rule 2026-07-23).
  if (bill.qb_source === "adopted") {
    return { queued: false, reason: "adopted_bill_readonly" };
  }
  if (!bill.purchase_order_id) {
    return { queued: false, reason: "bill has no purchase order" };
  }

  const poResult = await knex.raw(
    `SELECT number, qb_purchase_order_list_id, vendor_id
       FROM purchase_order
      WHERE id = ? AND deleted_at IS NULL`,
    [bill.purchase_order_id]
  );
  const po = (poResult.rows[0] ?? null) as PoRow | null;
  if (!po) return { queued: false, reason: "purchase order not found" };

  // Phase 2 scope fence — China-agent bills use the 4-bill clearing structure.
  if (po.vendor_id) {
    const agentResult = await knex.raw(
      `SELECT 1 FROM qb_vendor
        WHERE id = ? AND deleted_at IS NULL
          AND COALESCE((metadata ->> 'is_china_agent') = 'true'
                       OR metadata @> '{"is_china_agent": true}'::jsonb, false)`,
      [po.vendor_id]
    );
    if (agentResult.rows.length > 0) {
      return { queued: false, reason: "china-agent bill — Phase 2 handles QB dispatch" };
    }
  }

  const linesResult = await knex.raw(
    `SELECT vbl.id, vbl.line_kind, vbl.line_type, vbl.sku, vbl.description,
            vbl.qty, vbl.unit_cost_cents, vbl.amount_cents,
            vbl.freight_account_list_id, vbl.qb_account_list_id,
            vbl.purchase_order_line_id,
            pol.qb_txn_line_id AS qb_po_txn_line_id,
            pv.metadata ->> 'quickbooks_id' AS variant_qb_item_list_id
       FROM vendor_bill_line vbl
       LEFT JOIN purchase_order_line pol
         ON pol.id = vbl.purchase_order_line_id AND pol.deleted_at IS NULL
       LEFT JOIN product_variant pv
         ON pv.id = vbl.product_variant_id AND pv.deleted_at IS NULL
      WHERE vbl.vendor_bill_id = ? AND vbl.deleted_at IS NULL
      ORDER BY vbl.created_at ASC`,
    [vendorBillId]
  );
  const lines = linesResult.rows as LineRow[];

  const productLines = lines.filter(
    (l) =>
      (l.line_type ?? "product") === "product" &&
      (l.line_kind ?? "po_item") !== "freight_charge"
  );

  // Sales tax rides INSIDE the item cost, not as its own ExpenseLine.
  //
  // WHY, and why it differs from freight/commission/tariff (which do go to
  // their own COGS accounts): ownership of `average_cost` depends on origin.
  // For a CHINA product the vendor bill owns it, so a pool can sit in a QB
  // expense account and our landed value still stands. For a USA product
  // QUICKBOOKS owns it — `sync-average-cost-core.ts` stamps
  // `average_cost = qb.avgCost` for every non-China variant. Anything not in
  // QB's item cost is therefore erased from our cost on the next Cost Sync.
  // Sales tax is a USA-vendor charge, so it has to be in the item cost or it
  // does not survive at all.
  //
  // Allocated by VALUE with the exact line-total allocator — the same basis
  // and the same engine as the landed pool — so Σ(line amounts) hits the
  // vendor invoice total to the penny. QB derives Amount = Quantity × Cost,
  // and the bridge caps Cost at 5 decimals (QBXML PRICETYPE; more triggers
  // error 3045), which the fractional per-unit below stays within.
  const taxCents = Number(bill.tax_amount_cents ?? 0);
  const taxByLine = allocateLineTotalsCents(
    Math.max(0, Math.round(taxCents)),
    productLines.map((l) => l.unit_cost_cents * l.qty)
  );

  const itemLines = productLines.map((l, i) => {
    const taxShare = taxByLine[i] ?? 0;
    const qty = Number(l.qty);
    return {
      vendor_bill_line_id: l.id,
      purchase_order_line_id: l.purchase_order_line_id,
      sku: l.sku,
      qb_po_txn_line_id: l.qb_po_txn_line_id,
      quantity: l.qty,
      unit_cost_cents:
        qty > 0 && taxShare > 0
          ? (l.unit_cost_cents * qty + taxShare) / qty
          : l.unit_cost_cents,
      qb_item_list_id: l.variant_qb_item_list_id,
      description: l.description,
    };
  });
  // Non-item charges, all positive ExpenseLines. Keep this set identical to
  // what the Mod path retains — QB deletes by omission on BillMod.
  const expenseLines: Array<{
    vendor_bill_line_id: string | null;
    account_list_id: string | null;
    amount_cents: number;
    memo: string | null;
  }> = lines
    .filter(
      (l) =>
        (l.line_type ?? "product") === "qb_account" &&
        // The tax_charge row is LOCAL bookkeeping only: it makes the bill's
        // payable (`SUM(unit_cost_cents × qty)`, read by
        // recomputeBillFinanceLinks) come to the vendor invoice total. Its
        // money reaches QuickBooks inside the item cost above — emitting it
        // here as well would bill the tax twice.
        l.line_kind !== "tax_charge"
    )
    .map((l) => ({
      vendor_bill_line_id: l.id,
      account_list_id: l.freight_account_list_id ?? l.qb_account_list_id,
      amount_cents: l.amount_cents ?? l.unit_cost_cents,
      memo: l.description,
    }));

  // Fail-closed: tax with nowhere to ride. Every cent of the header amount must
  // land on a product line, or the QB bill posts an AP balance short by the
  // difference that never clears against the real payment. A tax-only bill (no
  // product lines) has no item cost to absorb it.
  if (taxCents > 0) {
    const placed = taxByLine.reduce((s, c) => s + c, 0);
    if (placed !== Math.round(taxCents)) {
      return {
        queued: false,
        reason: `sales tax ${taxCents}c could not be placed on the item lines (placed ${placed}c)`,
      };
    }
  }

  if (expenseLines.some((l) => !l.account_list_id)) {
    return { queued: false, reason: "an expense line has no QB account" };
  }

  if (itemLines.length === 0 && expenseLines.length === 0) {
    return { queued: false, reason: "bill has no lines to send" };
  }

  const toDateOnly = (v: string | null): string | null => {
    if (!v) return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  };

  const payload = {
    vendor_bill_id: bill.id,
    po_id: bill.purchase_order_id,
    po_number: po.number,
    ref_number: bill.reference_id,
    memo: `EcoPowerTech ${bill.number ?? bill.id} / ${po.number ?? bill.purchase_order_id}`,
    vendor_qb_list_id: bill.vendor_qb_list_id_snapshot,
    vendor_name: bill.vendor_name_snapshot,
    txn_date: toDateOnly(bill.document_date),
    due_date: toDateOnly(bill.due_date),
    rebuild_generation: bill.rebuild_generation,
    po_txn_id: po.qb_purchase_order_list_id,
    item_lines: itemLines,
    expense_lines: expenseLines,
  };

  // One-row-per-bill: UPDATE-first, INSERT-fallback (2026-07-15 rule). Only a
  // non-terminal-in-flight row is reused; an already-synced row is left alone
  // (the poller's object-state gate owns re-adds via rebuild_generation).
  const updateResult = await knex.raw(
    `UPDATE qb_vendor_bill_pipeline
        SET status = 'waiting',
            intent = 'add',
            payload = ?::jsonb,
            qb_operation_id = NULL,
            retries = 0,
            last_error = NULL,
            next_retry_at = NULL,
            updated_at = NOW()
      WHERE vendor_bill_id = ?
        AND deleted_at IS NULL
        AND status IN ('waiting', 'error', 'failed_permanent')
      RETURNING id`,
    [JSON.stringify(payload), vendorBillId]
  );
  const updatedRow = updateResult.rows[0] as { id: string } | undefined;
  let pipelineRowId = updatedRow?.id ?? null;

  if (!pipelineRowId) {
    const existing = await knex.raw(
      `SELECT id, status FROM qb_vendor_bill_pipeline
        WHERE vendor_bill_id = ? AND deleted_at IS NULL LIMIT 1`,
      [vendorBillId]
    );
    const existingRow = existing.rows[0] as
      | { id: string; status: string }
      | undefined;
    if (existingRow) {
      // submitted/synced — never clobber an in-flight or completed ADD.
      return {
        queued: false,
        reason: `pipeline row already '${existingRow.status}' — not re-enqueued`,
      };
    }

    const insertResult = await knex.raw(
      `INSERT INTO qb_vendor_bill_pipeline
         (id, vendor_bill_id, purchase_order_id, status, intent, payload,
          created_at, updated_at)
       VALUES (?, ?, ?, 'waiting', 'add', ?::jsonb, NOW(), NOW())
       RETURNING id`,
      [
        `qbvbpipe_${Date.now().toString(36)}${Math.random()
          .toString(36)
          .slice(2, 10)}`,
        vendorBillId,
        bill.purchase_order_id,
        JSON.stringify(payload),
      ]
    );
    pipelineRowId = String(
      (insertResult.rows[0] as { id: string }).id
    );
  }

  const orderPayload = {
    ...payload,
    qb_vendor_bill_pipeline_id: pipelineRowId,
  };
  const operation = await enqueuePurchaseQbOperation(knex, {
    purchaseOrderId: bill.purchase_order_id,
    referenceId: vendorBillId,
    referenceType: "vendor_bill",
    step: "vendor_bill_add",
    payload: orderPayload,
    operationKey: purchaseOperationKey(
      "vendor_bill_add",
      vendorBillId,
      orderPayload
    ),
  });
  await knex.raw(
    `UPDATE qb_vendor_bill_pipeline
        SET order_pipeline_id = ?, updated_at = NOW()
      WHERE id = ?`,
    [operation.id, pipelineRowId]
  );
  return { queued: true, pipelineRowId };
}
