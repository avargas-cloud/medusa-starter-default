/**
 * POST /admin/purchase-orders/:id/receipts/:receiptId/vendor-bill/confirm
 *
 * Confirms a draft vendor bill:
 *   1. Distributes commission / freight / tariff to each line (same as before)
 *   2. Assigns the sequential VB-XXXX number (drafts have no number until confirm)
 *   3. Updates product_variant.metadata.avg_landed_cost_cents using QB-style AVCO:
 *        new_avg = (Q_before × old_avg + received_qty × landed_cost) / Q_on_hand
 *      where Q_before = Q_on_hand - received_qty (inventory before this receipt)
 *   4. Writes one vendor_bill_cost_log row per variant for audit + cancel reversal
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { getActorUserId, UnauthenticatedError } from "../../../../../_lib/auth";
import { getPurchaseOrdersService } from "../../../../../_lib/service-resolver";

// ── Typed shapes ─────────────────────────────────────────────────────────────

interface VendorBillRow {
  id: string;
  number: string | null;
  status: string;
  purchase_order_id: string;
  purchase_order_receipt_id: string;
  commission_mode: string;
  commission_rate_bps: number;
  commission_amount_cents: number;
  service_vendor_bill_id: string | null;
  freight_included: boolean;
  freight_amount_cents: number;
  tariff_included: boolean;
  tariff_amount_cents: number;
}

interface VendorBillLineRow {
  id: string;
  product_variant_id: string;
  purchase_order_line_id: string | null;
  line_type: string | null;
  qty: number;
  unit_cost_cents: number;
}

interface VariantMetadataRow {
  metadata: Record<string, unknown> | null;
}

// ── Knex type ─────────────────────────────────────────────────────────────────

type KnexInstance = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
};

function resolveKnex(req: AuthenticatedMedusaRequest): KnexInstance {
  return (req.scope as unknown as { resolve: (k: string) => unknown }).resolve(
    "__pg_connection__"
  ) as KnexInstance;
}

// ── POST handler ─────────────────────────────────────────────────────────────

export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  let userId: string;
  try {
    userId = getActorUserId(req);
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      return res
        .status(err.status)
        .json({ error: err.message, code: err.code });
    }
    throw err;
  }

  const { id: poId, receiptId } = req.params as {
    id: string;
    receiptId: string;
  };

  const service = getPurchaseOrdersService(req);
  const knex = resolveKnex(req);

  // 1. Validate receipt belongs to PO
  const receipt = (await service
    .retrievePurchaseOrderReceipt(receiptId)
    .catch(() => null)) as unknown as {
    id: string;
    purchase_order_id: string;
  } | null;

  if (!receipt) {
    return res.status(404).json({ error: "Receipt not found", code: "not_found" });
  }
  if (receipt.purchase_order_id !== poId) {
    return res.status(400).json({
      error: "Receipt does not belong to this purchase order",
      code: "receipt_mismatch",
    });
  }

  // Per-shipment confirm (Option A): allow confirming as soon as a shipment
  // lands — the PO may still be partially_received. The TARGET receipt itself
  // must be applied/synced (AVCO is receipt-line based).
  const poStatusResult = await knex.raw(
    `SELECT status FROM purchase_order WHERE id = ? AND deleted_at IS NULL`,
    [poId]
  );
  const poStatus = (poStatusResult.rows[0] as { status?: string } | undefined)?.status;
  if (poStatus !== "received" && poStatus !== "partially_received") {
    return res.status(422).json({
      error: "Purchase order must be received (or partially received) before confirming a vendor bill",
      code: "po_not_receivable",
    });
  }

  const receiptStatusResult = await knex.raw(
    `SELECT status FROM purchase_order_receipt WHERE id = ? AND deleted_at IS NULL`,
    [receiptId]
  );
  const receiptStatus = (receiptStatusResult.rows[0] as { status?: string } | undefined)?.status;
  if (receiptStatus !== "applied" && receiptStatus !== "synced") {
    return res.status(422).json({
      error: "This receipt is not applied yet — cannot confirm its vendor bill",
      code: "receipt_not_applied",
    });
  }

  // 2. Resolve the target bill. Option A = one regular bill per receipt, so bind
  //    EXPLICITLY: prefer the caller's vendor_bill_id, else the bill pinned to
  //    THIS receipt. The legacy "earliest unpinned PO bill" fallback is removed —
  //    with multiple regular bills per PO it could confirm the wrong one.
  const explicitBillId =
    typeof (req.body as { vendor_bill_id?: unknown })?.vendor_bill_id === "string"
      ? (req.body as { vendor_bill_id: string }).vendor_bill_id
      : null;

  const billResult = explicitBillId
    ? await knex.raw(
        `SELECT *
         FROM vendor_bill
         WHERE id = ?
           AND deleted_at IS NULL
           AND bill_type = 'regular'
           AND purchase_order_id = ?
           AND (purchase_order_receipt_id = ? OR purchase_order_receipt_id IS NULL)
         LIMIT 1`,
        [explicitBillId, poId, receiptId]
      )
    : await knex.raw(
        `SELECT *
         FROM vendor_bill
         WHERE deleted_at IS NULL
           AND bill_type = 'regular'
           AND purchase_order_receipt_id = ?
         ORDER BY created_at ASC
         LIMIT 1`,
        [receiptId]
      );

  const bill = (billResult.rows[0] ?? null) as VendorBillRow | null;
  if (!bill) {
    return res.status(404).json({
      error: "No vendor bill is pinned to this receipt — create or pin one first",
      code: "not_found",
    });
  }
  if (bill.status !== "draft") {
    return res.status(409).json({
      error: `Vendor bill is already in status '${bill.status}'`,
      code: "not_draft",
    });
  }
  if (!bill.purchase_order_receipt_id) {
    // Pin the explicit bill to this receipt — preflight the UNIQUE(receipt) index.
    const pinnedElsewhere = await knex.raw(
      `SELECT id FROM vendor_bill
       WHERE purchase_order_receipt_id = ? AND id <> ? AND deleted_at IS NULL
       LIMIT 1`,
      [receiptId, bill.id]
    );
    if (pinnedElsewhere.rows.length > 0) {
      return res.status(409).json({
        error: "Another vendor bill is already pinned to this receipt",
        code: "receipt_already_pinned",
      });
    }
    await knex.raw(
      `UPDATE vendor_bill
       SET purchase_order_receipt_id = ?, updated_at = NOW()
       WHERE id = ? AND deleted_at IS NULL`,
      [receiptId, bill.id]
    );
    bill.purchase_order_receipt_id = receiptId;
  }

  // 3. Fetch vendor bill lines
  const lines = (await service.listVendorBillLines(
    { vendor_bill_id: bill.id },
    { take: 1000 }
  )) as unknown as VendorBillLineRow[];

  if (lines.length === 0) {
    return res.status(422).json({
      error: "Vendor bill has no lines",
      code: "no_lines",
    });
  }

  // 3b. AVCO safety: the bill's product lines MUST mirror THIS receipt's
  //     received lines by purchase_order_line_id AND quantity. Confirm uses the
  //     bill-line qty as the AVCO numerator but receipt snapshots as the
  //     denominator — a divergence (e.g. a PO-ordered-sourced bill confirmed
  //     against a partial receipt) corrupts landed cost. Reconcile via
  //     "Update from Receipt" before confirming.
  const productLines = lines.filter(
    (l) => (l.line_type ?? "product") === "product"
  );
  const { rows: receiptAggRows } = (await knex.raw(
    `SELECT purchase_order_line_id,
            COALESCE(SUM(qty_received_now), 0)::int AS qty
       FROM purchase_order_receipt_line
      WHERE purchase_order_receipt_id = ? AND deleted_at IS NULL
      GROUP BY purchase_order_line_id`,
    [receiptId]
  )) as { rows: Array<{ purchase_order_line_id: string; qty: number }> };

  const billByPol = new Map<string, number>();
  let billHasUnlinked = false;
  for (const l of productLines) {
    if (!l.purchase_order_line_id) {
      billHasUnlinked = true;
      break;
    }
    billByPol.set(
      l.purchase_order_line_id,
      (billByPol.get(l.purchase_order_line_id) ?? 0) + l.qty
    );
  }
  const rcptByPol = new Map<string, number>();
  for (const r of receiptAggRows) {
    rcptByPol.set(
      r.purchase_order_line_id,
      (rcptByPol.get(r.purchase_order_line_id) ?? 0) + r.qty
    );
  }
  const qtyMismatch =
    billHasUnlinked ||
    billByPol.size !== rcptByPol.size ||
    [...billByPol.entries()].some(([pol, q]) => rcptByPol.get(pol) !== q) ||
    [...rcptByPol.entries()].some(([pol, q]) => billByPol.get(pol) !== q);
  if (qtyMismatch) {
    return res.status(422).json({
      error:
        "Vendor bill quantities don't match this receipt. Run 'Update from Receipt' so the bill mirrors the shipment exactly, then confirm.",
      code: "bill_receipt_qty_mismatch",
    });
  }

  // 4. Fetch CBM from product_variant.metadata for each unique variant
  const uniqueVariantIds = [...new Set(lines.map((l) => l.product_variant_id))];

  const cbmByVariantId = new Map<string, number | null>();
  await Promise.all(
    uniqueVariantIds.map(async (variantId) => {
      const result = await knex.raw(
        `SELECT metadata FROM product_variant WHERE id = ? AND deleted_at IS NULL`,
        [variantId]
      );
      const row = (result.rows[0] ?? null) as VariantMetadataRow | null;
      const cbm =
        row?.metadata?.cbm !== undefined && row.metadata.cbm !== null
          ? Number(row.metadata.cbm)
          : null;
      cbmByVariantId.set(variantId, isNaN(cbm as number) ? null : cbm);
    })
  );

  // 5. Compute aggregates for cost distribution
  let totalCbm = 0;
  let totalSubtotalCents = 0;
  let totalQty = 0;

  for (const line of lines) {
    const cbm = cbmByVariantId.get(line.product_variant_id) ?? null;
    if (cbm !== null) totalCbm += cbm * line.qty;
    totalSubtotalCents += line.unit_cost_cents * line.qty;
    totalQty += line.qty;
  }

  let serviceBillTotalCents = 0;
  if (bill.service_vendor_bill_id) {
    const serviceBillResult = await knex.raw(
      `SELECT COALESCE(SUM(vbl.landed_unit_cost_cents * vbl.qty), 0)::int AS total
       FROM vendor_bill vb
       JOIN vendor_bill_line vbl
         ON vbl.vendor_bill_id = vb.id
        AND vbl.deleted_at IS NULL
       WHERE vb.id = ?
         AND vb.deleted_at IS NULL
         AND vb.bill_type = 'service'
         AND vb.status IN ('draft', 'confirmed')`,
      [bill.service_vendor_bill_id]
    );
    serviceBillTotalCents = Number(
      (serviceBillResult.rows[0] as { total: number | string } | undefined)?.total ?? 0
    );
  }

  // 6. Calculate per-unit cost components
  type LineUpdate = {
    id: string;
    cbm_per_unit: number | null;
    commission_per_unit_cents: number;
    freight_per_unit_cents: number;
    tariff_per_unit_cents: number;
    landed_unit_cost_cents: number;
  };

  const lineUpdates: LineUpdate[] = lines.map((line) => {
    const cbm = cbmByVariantId.get(line.product_variant_id) ?? null;

    const commissionPerUnit =
      totalQty > 0 ? Math.round(serviceBillTotalCents / totalQty) : 0;

    let freightPerUnit = 0;
    if (bill.freight_included && totalCbm > 0 && cbm !== null) {
      freightPerUnit = Math.round((cbm / totalCbm) * bill.freight_amount_cents);
    }

    let tariffPerUnit = 0;
    if (bill.tariff_included && totalSubtotalCents > 0) {
      tariffPerUnit = Math.round(
        (line.unit_cost_cents / totalSubtotalCents) * bill.tariff_amount_cents
      );
    }

    return {
      id: line.id,
      cbm_per_unit: cbm,
      commission_per_unit_cents: commissionPerUnit,
      freight_per_unit_cents: freightPerUnit,
      tariff_per_unit_cents: tariffPerUnit,
      landed_unit_cost_cents:
        line.unit_cost_cents + commissionPerUnit + freightPerUnit + tariffPerUnit,
    };
  });

  // 7. Persist line updates
  await Promise.all(
    lineUpdates.map((fields) =>
      knex.raw(
        `UPDATE vendor_bill_line
         SET cbm_per_unit = ?::float,
             commission_per_unit_cents = ?,
             freight_per_unit_cents = ?,
             tariff_per_unit_cents = ?,
             landed_unit_cost_cents = ?,
             updated_at = NOW()
         WHERE id = ? AND deleted_at IS NULL`,
        [
          fields.cbm_per_unit,
          fields.commission_per_unit_cents,
          fields.freight_per_unit_cents,
          fields.tariff_per_unit_cents,
          fields.landed_unit_cost_cents,
          fields.id,
        ]
      )
    )
  );

  // 8. Keep the draft's VB-XXXX number; backfill only legacy unnumbered drafts.
  let vbNumber = bill.number;
  if (!vbNumber) {
    const seqResult = await knex.raw(
      `SELECT nextval('custom_vendor_bill_seq') AS seq`
    );
    vbNumber = `VB-${(seqResult.rows[0] as { seq: string | number }).seq}`;
  }

  // 9. Mark bill as confirmed.
  await knex.raw(
    `UPDATE vendor_bill
     SET number = ?,
         status = 'confirmed',
         confirmed_at = NOW(),
         confirmed_by_user_id = ?,
         updated_at = NOW()
     WHERE id = ? AND deleted_at IS NULL`,
    [vbNumber, userId, bill.id]
  );

  // 10. AVCO: update avg_landed_cost_cents per variant using QB weighted-average formula
  //     new_avg = (Q_before × old_avg + received_qty × batch_landed) / Q_on_hand
  //     where Q_before = Q_on_hand - received_qty (inventory before this receipt)

  // Aggregate by variant: totalLanded and totalQty across all lines for this bill
  const landedByVariant = new Map<
    string,
    { totalLanded: number; totalQty: number }
  >();
  for (const update of lineUpdates) {
    const line = lines.find((l) => l.id === update.id)!;
    const prev = landedByVariant.get(line.product_variant_id) ?? {
      totalLanded: 0,
      totalQty: 0,
    };
    landedByVariant.set(line.product_variant_id, {
      totalLanded: prev.totalLanded + update.landed_unit_cost_cents * line.qty,
      totalQty: prev.totalQty + line.qty,
    });
  }

  await Promise.all(
    [...landedByVariant.entries()].map(async ([variantId, { totalLanded, totalQty: receivedQty }]) => {
      const batchLandedPerUnit = receivedQty > 0 ? totalLanded / receivedQty : 0;

      // Read qty_on_hand captured at receive time (per-location, same scope as receipt).
      // For pre-fix receipts the column is NULL — fall back to live cross-location sum.
      const stockRes = await knex.raw(
        `SELECT
           COALESCE(SUM(rl.qty_on_hand_at_receive)::int, 0) AS q_before,
           COALESCE(SUM(rl.qty_received_now)::int, 0)       AS q_received,
           BOOL_AND(rl.qty_on_hand_at_receive IS NOT NULL)  AS has_capture
         FROM purchase_order_receipt_line rl
         WHERE rl.purchase_order_receipt_id = ?
           AND rl.product_variant_id = ?
           AND rl.deleted_at IS NULL`,
        [receiptId, variantId]
      );
      const stockRow = stockRes.rows[0] as
        | { q_before: number; q_received: number; has_capture: boolean }
        | undefined;

      let qBefore: number;
      let qOnHand: number;
      if (stockRow?.has_capture) {
        // Post-fix path: use the historical snapshot
        qBefore = stockRow.q_before;
        qOnHand = qBefore + stockRow.q_received;
      } else {
        // Pre-fix fallback: read current inventory (old behaviour)
        const fallbackRes = await knex.raw(
          `SELECT COALESCE(SUM(il.stocked_quantity)::int, 0) AS qty
           FROM inventory_level il
           JOIN product_variant_inventory_item pvii ON pvii.inventory_item_id = il.inventory_item_id
           WHERE pvii.variant_id = ? AND il.deleted_at IS NULL`,
          [variantId]
        );
        const currentQty =
          (fallbackRes.rows[0] as { qty: number } | undefined)?.qty ?? 0;
        qOnHand = currentQty;
        qBefore = Math.max(0, qOnHand - receivedQty);
      }

      // Read current avg (prev avg before this bill)
      const metaResult = await knex.raw(
        `SELECT metadata FROM product_variant WHERE id = ? AND deleted_at IS NULL`,
        [variantId]
      );
      const meta = (metaResult.rows[0] as VariantMetadataRow | undefined)?.metadata;
      const prevAvg = Number(meta?.avg_landed_cost_cents ?? 0) || 0;

      // QB-style AVCO: new_avg = (Q_before × old_avg + received × landed) / Q_on_hand
      const newAvg =
        qOnHand > 0
          ? (qBefore * prevAvg + receivedQty * batchLandedPerUnit) / qOnHand
          : batchLandedPerUnit;

      // Persist new running average
      await knex.raw(
        `UPDATE product_variant
         SET metadata = COALESCE(metadata, '{}'::jsonb)
           || jsonb_build_object('avg_landed_cost_cents', ?::float),
             updated_at = NOW()
         WHERE id = ?`,
        [newAvg, variantId]
      );

      // Write cost log row — used for cancel reversal and audit trail
      await knex.raw(
        `INSERT INTO vendor_bill_cost_log
           (vendor_bill_id, product_variant_id, received_qty, landed_unit_cost_cents,
            prev_qty_on_hand, prev_avg_cost_cents, new_avg_cost_cents)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [bill.id, variantId, receivedQty, batchLandedPerUnit, qBefore, prevAvg, newAvg]
      );
    })
  );

  // 11. Return confirmed bill with updated lines
  const confirmedBill = await service.listVendorBills({ id: bill.id }, { take: 1 });
  const confirmedLines = await service.listVendorBillLines(
    { vendor_bill_id: bill.id },
    { take: 1000 }
  );

  return res.json({
    vendor_bill: {
      ...(confirmedBill[0] ?? {}),
      lines: confirmedLines,
    },
  });
}
