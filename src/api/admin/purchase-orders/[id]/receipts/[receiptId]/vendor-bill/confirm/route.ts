/**
 * POST /admin/purchase-orders/:id/receipts/:receiptId/vendor-bill/confirm
 *
 * Confirms a draft vendor bill:
 *   1. Distributes commission / freight / tariff to each line (same as before)
 *   2. Assigns the sequential VB-XXXX number (drafts have no number until confirm)
 *   3. Updates product_variant.metadata.avg_landed_cost_cents using QB-style AVCO:
 *        new_avg = (Q_before × old_avg + received_qty × landed_cost) / Q_on_hand
 *      where Q_before = Q_on_hand - received_qty (inventory before that receipt)
 *   4. Writes one vendor_bill_cost_log row PER RECEIPT for audit + cancel reversal
 *
 * D6 (docs/VENDOR_BILL_QB_SYNC_PLAN.md §3.0 + §5) — a bill may cover MULTIPLE
 * receipts. Pass `receipt_ids: string[]` in the body to confirm against an
 * explicit set (validated + auto-bound); the URL `receiptId` must be a member.
 * Without it, the bill's already-bound receipts are used (dual-read), falling
 * back to the single URL receiptId for the original single-receipt flow. AVCO
 * replays each variant chronologically across the set (oldest receipt first)
 * instead of a single aggregate step — see the AVCO section below.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { getActorUserId, UnauthenticatedError } from "../../../../../_lib/auth";
import { getPurchaseOrdersService } from "../../../../../_lib/service-resolver";
import { computeLandedLines } from "../../../../../../../../lib/purchase-orders/landed-allocation";
import {
  applyReceiptToAvco,
  resolveAvgCostSeedCents,
} from "../../../../../../../../lib/cost/avco";
import {
  recostSalesWindow,
  type RecostKnex,
} from "../../../../../../../../lib/cost/recost-window";
import {
  resolveBoundReceiptIds,
  syncPrimaryReceiptPointer,
  validateReceiptsForBinding,
} from "../../../../../../../../lib/purchase-orders/vendor-bill-receipts";
import { enqueueQbVendorBillAdd } from "../../../../../../../../lib/purchase-orders/qb-vendor-bill-enqueue";

// ── Typed shapes ─────────────────────────────────────────────────────────────

interface VendorBillRow {
  id: string;
  number: string | null;
  status: string;
  reference_id: string | null;
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
  // Used by the AVCO step to surface a negative-inventory settlement: that
  // true-up is a real COGS correction that deliberately does NOT go into the
  // average, so it must never be silent.
  const logger = req.scope.resolve("logger") as { warn: (message: string) => void };

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
  //
  //    D6 dual-read: a bill can also be found by the NEW receipt-side FK, not
  //    just the legacy `purchase_order_receipt_id` mirror — e.g. confirming via
  //    a receipt that was bound to this bill as its 2nd/3rd receipt (so it is
  //    NOT the bill's legacy "primary" pointer).
  const explicitBillId =
    typeof (req.body as { vendor_bill_id?: unknown })?.vendor_bill_id === "string"
      ? (req.body as { vendor_bill_id: string }).vendor_bill_id
      : null;
  // Normalized to `null` when absent OR an explicit empty array — an empty
  // set must fall through to the same "nothing given" branches below, not a
  // half-handled state where the legacy auto-pin is skipped but nothing else
  // binds the receipt either.
  const rawBodyReceiptIds = Array.isArray((req.body as { receipt_ids?: unknown })?.receipt_ids)
    ? ((req.body as { receipt_ids: unknown[] }).receipt_ids.filter(
        (v): v is string => typeof v === "string" && v.length > 0
      ) as string[])
    : null;
  const bodyReceiptIds = rawBodyReceiptIds && rawBodyReceiptIds.length > 0 ? rawBodyReceiptIds : null;

  const billResult = explicitBillId
    ? await knex.raw(
        `SELECT *
         FROM vendor_bill
         WHERE id = ?
           AND deleted_at IS NULL
           AND bill_type = 'regular'
           AND purchase_order_id = ?
           AND (
             purchase_order_receipt_id = ?
             OR purchase_order_receipt_id IS NULL
             OR EXISTS (
               SELECT 1 FROM purchase_order_receipt bpor
               WHERE bpor.id = ? AND bpor.vendor_bill_id = vendor_bill.id
             )
           )
         LIMIT 1`,
        [explicitBillId, poId, receiptId, receiptId]
      )
    : await knex.raw(
        `SELECT *
         FROM vendor_bill
         WHERE deleted_at IS NULL
           AND bill_type = 'regular'
           AND (
             purchase_order_receipt_id = ?
             OR EXISTS (
               SELECT 1 FROM purchase_order_receipt bpor
               WHERE bpor.id = ? AND bpor.vendor_bill_id = vendor_bill.id
             )
           )
         ORDER BY created_at ASC
         LIMIT 1`,
        [receiptId, receiptId]
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
  // Vendor Invoice Reference is MANDATORY at confirm (owner 2026-07-23): it
  // becomes the QuickBooks Bill "Ref No." — the accountant reconciles and ages
  // payables by it, and the QB pipeline's duplicate existence-check matches on
  // it. Drafts may exist without one (proforma, D7); confirming may not.
  if (!bill.reference_id || !bill.reference_id.trim()) {
    return res.status(409).json({
      error:
        "Vendor invoice reference is required before confirming — it becomes the Bill's Ref No. in QuickBooks",
      code: "vendor_reference_required",
    });
  }

  // 2b. Resolve the RECEIPT SET this confirm covers (D6):
  //   - body.receipt_ids (validated + auto-bound, additive only — never
  //     unbinds; that's the PATCH route's job) if provided; the URL receiptId
  //     must be a member.
  //   - else the bill's already-bound receipts (dual-read).
  //   - else (nothing bound yet, no receipt_ids given) the legacy single
  //     receiptId from the URL — original single-receipt behaviour, pinned
  //     below exactly as before.
  let receiptIdSet: string[];
  if (bodyReceiptIds && bodyReceiptIds.length > 0) {
    if (!bodyReceiptIds.includes(receiptId)) {
      return res.status(400).json({
        error: "receipt_ids must include the receipt referenced in the URL",
        code: "receipt_id_not_in_set",
      });
    }
    const validation = await validateReceiptsForBinding(knex, {
      purchaseOrderId: poId,
      billId: bill.id,
      receiptIds: bodyReceiptIds,
    });
    if (!validation.ok) {
      return res.status(validation.status).json(validation.body);
    }
    const alreadyBound = new Set(
      await resolveBoundReceiptIds(knex, bill.id, bill.purchase_order_receipt_id)
    );
    const toBind = bodyReceiptIds.filter((rid) => !alreadyBound.has(rid));
    if (toBind.length > 0) {
      await knex.raw(
        `UPDATE purchase_order_receipt SET vendor_bill_id = ?, updated_at = NOW()
          WHERE id = ANY(?) AND deleted_at IS NULL`,
        [bill.id, toBind]
      );
      await syncPrimaryReceiptPointer(knex, bill.id);
      const refreshed = await knex.raw(
        `SELECT purchase_order_receipt_id FROM vendor_bill WHERE id = ? AND deleted_at IS NULL`,
        [bill.id]
      );
      bill.purchase_order_receipt_id =
        (refreshed.rows[0] as { purchase_order_receipt_id: string | null } | undefined)
          ?.purchase_order_receipt_id ?? bill.purchase_order_receipt_id;
    }
    receiptIdSet = bodyReceiptIds;
  } else {
    const bound = await resolveBoundReceiptIds(knex, bill.id, bill.purchase_order_receipt_id);
    if (bound.length > 0) {
      receiptIdSet = bound;
    } else {
      // Receipt-less bill (a "Fill from PO" draft, D8a): the whole-order bill
      // confirms against ALL of the PO's applied receipts not owned by another
      // bill — NOT just the URL's single receipt (a partial receipt would fail
      // the qty-match against full-PO quantities; seen on VB-1068). The URL
      // receiptId is required to be in that set (sanity: same PO, applied).
      const allUnbound = await knex.raw(
        `SELECT por.id
           FROM purchase_order_receipt por
          WHERE por.purchase_order_id = ?
            AND por.status IN ('applied','synced')
            AND por.deleted_at IS NULL
            AND (por.vendor_bill_id IS NULL OR por.vendor_bill_id = ?)
            AND NOT EXISTS (
              SELECT 1 FROM vendor_bill vb
              WHERE vb.purchase_order_receipt_id = por.id
                AND vb.id <> ? AND vb.deleted_at IS NULL
            )
          ORDER BY por.received_at ASC, por.seq ASC`,
        [poId, bill.id, bill.id]
      );
      const unboundIds = (allUnbound.rows as Array<{ id: string }>).map((r) => r.id);
      receiptIdSet = unboundIds.includes(receiptId)
        ? unboundIds
        : [receiptId];
      if (receiptIdSet.length > 1) {
        // Bind the resolved set so the bill's receipts are explicit from here
        // on (chips, drift, Rcv'd all read the binding).
        await knex.raw(
          `UPDATE purchase_order_receipt SET vendor_bill_id = ?, updated_at = NOW()
            WHERE id = ANY(?) AND deleted_at IS NULL`,
          [bill.id, receiptIdSet]
        );
        await syncPrimaryReceiptPointer(knex, bill.id);
        const refreshedPin = await knex.raw(
          `SELECT purchase_order_receipt_id FROM vendor_bill WHERE id = ? AND deleted_at IS NULL`,
          [bill.id]
        );
        bill.purchase_order_receipt_id =
          (refreshedPin.rows[0] as { purchase_order_receipt_id: string | null } | undefined)
            ?.purchase_order_receipt_id ?? bill.purchase_order_receipt_id;
      }
    }
  }

  if (!bodyReceiptIds && !bill.purchase_order_receipt_id) {
    // Legacy single-receipt behaviour, unchanged: pin the explicit bill to
    // this receipt — preflight the UNIQUE(receipt) index (legacy column) AND
    // the new per-receipt FK (dual-read/dual-write).
    const pinnedElsewhere = await knex.raw(
      `SELECT id FROM vendor_bill
       WHERE purchase_order_receipt_id = ? AND id <> ? AND deleted_at IS NULL
       LIMIT 1`,
      [receiptId, bill.id]
    );
    const fkPinnedElsewhere = await knex.raw(
      `SELECT vendor_bill_id FROM purchase_order_receipt
       WHERE id = ? AND vendor_bill_id IS NOT NULL AND vendor_bill_id <> ? AND deleted_at IS NULL`,
      [receiptId, bill.id]
    );
    if (pinnedElsewhere.rows.length > 0 || fkPinnedElsewhere.rows.length > 0) {
      return res.status(409).json({
        error: "Another vendor bill is already pinned to this receipt",
        code: "receipt_already_pinned",
      });
    }
    await knex.raw(
      `UPDATE purchase_order_receipt SET vendor_bill_id = ?, updated_at = NOW()
       WHERE id = ? AND deleted_at IS NULL`,
      [bill.id, receiptId]
    );
    await syncPrimaryReceiptPointer(knex, bill.id);
    bill.purchase_order_receipt_id = receiptId;
    receiptIdSet = [receiptId];
  }

  // 2c. Every receipt in the resolved set must be applied/synced (D6 — was
  // previously checked only for the single URL receiptId).
  const setStatusResult = await knex.raw(
    `SELECT id, status FROM purchase_order_receipt
      WHERE id = ANY(?) AND deleted_at IS NULL`,
    [receiptIdSet]
  );
  const setStatusRows = setStatusResult.rows as Array<{ id: string; status: string }>;
  const notApplied = setStatusRows.find((r) => r.status !== "applied" && r.status !== "synced");
  if (notApplied || setStatusRows.length !== receiptIdSet.length) {
    return res.status(422).json({
      error: "All receipts bound to this vendor bill must be applied before confirming",
      code: "receipt_not_applied",
    });
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

  // 3b. AVCO safety: the bill's product lines MUST mirror the received lines
  //     ACROSS THE WHOLE RECEIPT SET (D6 — was a single receipt) by
  //     purchase_order_line_id AND quantity. Confirm uses the bill-line qty as
  //     the AVCO numerator but the receipts' snapshots as the denominator — a
  //     divergence (e.g. a PO-ordered-sourced bill confirmed against a partial
  //     receipt) corrupts landed cost. Reconcile via "Update from Receipt(s)"
  //     before confirming.
  const productLines = lines.filter(
    (l) => (l.line_type ?? "product") === "product"
  );
  const { rows: receiptAggRows } = (await knex.raw(
    `SELECT purchase_order_line_id,
            COALESCE(SUM(qty_received_now), 0)::int AS qty
       FROM purchase_order_receipt_line
      WHERE purchase_order_receipt_id = ANY(?) AND deleted_at IS NULL
      GROUP BY purchase_order_line_id`,
    [receiptIdSet]
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

  // 4. Fetch CBM from product_variant.metadata for each unique variant.
  //    Scoped to productLines — freight charge lines (line_type='qb_account',
  //    line_kind='freight_charge') carry no product_variant_id and must never
  //    enter the landed-cost allocation below (§7 of the QB sync plan: a
  //    freight charge is a flat non-landed ExpenseLine, not a cost pool input).
  const uniqueVariantIds = [
    ...new Set(productLines.map((l) => l.product_variant_id)),
  ];

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

  // 5. Resolve the commission (service-bill) pool. Freight/tariff totals live on
  //    the bill header. Per-line weights are computed inside computeLandedLines.
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

  // Largest-remainder allocation (shared with the store-pos draft preview via
  // computeLandedLines) so Σ(perUnit × qty) lands on the exact pool total — no
  // rounding drift, no manual "plug" line on the QuickBooks bill. Pools are
  // gated exactly as before: commission only when a service bill is linked
  // (serviceBillTotalCents=0 otherwise), freight/tariff only when included.
  const cbmPerLine = productLines.map(
    (line) => cbmByVariantId.get(line.product_variant_id) ?? null
  );
  const landed = computeLandedLines(
    productLines.map((line, i) => ({
      qty: line.qty,
      unit_cost_cents: line.unit_cost_cents,
      cbm_per_unit: cbmPerLine[i] ?? null,
    })),
    {
      commissionCents: serviceBillTotalCents,
      freightCents: bill.freight_included ? bill.freight_amount_cents : 0,
      tariffCents: bill.tariff_included ? bill.tariff_amount_cents : 0,
    }
  );

  const lineUpdates: LineUpdate[] = productLines.map((line, i) => {
    const r = landed.lines[i]!;
    return {
      id: line.id,
      cbm_per_unit: cbmPerLine[i] ?? null,
      commission_per_unit_cents: r.commission_per_unit_cents,
      freight_per_unit_cents: r.freight_per_unit_cents,
      tariff_per_unit_cents: r.tariff_per_unit_cents,
      landed_unit_cost_cents: r.landed_unit_cost_cents,
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
  //     where Q_before = Q_on_hand - received_qty (inventory before that receipt)
  //
  //     D6 — CHRONOLOGICAL REPLAY (plan §5): summing q_before across several
  //     receipts double-counts pre-existing/inter-receipt stock, so when this
  //     bill covers MULTIPLE receipts each variant is replayed one receipt at
  //     a time, oldest first, chaining the running average:
  //       avg_i = (q_before_i × avg_{i-1} + qty_i × landed_unit) / (q_before_i + qty_i)
  //     using EACH receipt's own captured qty_on_hand_at_receive as q_before_i.
  //     Landed unit cost is uniform across the bill's receipts (one invoice —
  //     the bill has ONE set of lines summed across the set), so only the
  //     quantities are replayed step by step. One vendor_bill_cost_log row is
  //     written PER RECEIPT (not per variant) so reversal/audit stays granular.
  //     For a single-receipt bill this is byte-identical to the old formula
  //     (the loop below runs exactly once).

  // Aggregate by variant: totalLanded and totalQty across all lines for this bill
  // (bill lines are already summed across the receipt set — see qty-match guard
  // above — so this landed-per-unit figure is uniform for the whole replay).
  const landedByVariant = new Map<
    string,
    { totalLanded: number; totalQty: number }
  >();
  for (const update of lineUpdates) {
    const line = productLines.find((l) => l.id === update.id)!;
    const prev = landedByVariant.get(line.product_variant_id) ?? {
      totalLanded: 0,
      totalQty: 0,
    };
    landedByVariant.set(line.product_variant_id, {
      totalLanded: prev.totalLanded + update.landed_unit_cost_cents * line.qty,
      totalQty: prev.totalQty + line.qty,
    });
  }

  // Chronological order (oldest first) for the whole receipt set — shared
  // across every variant's replay below.
  const receiptOrderResult = await knex.raw(
    `SELECT id, received_at, seq FROM purchase_order_receipt
      WHERE id = ANY(?) AND deleted_at IS NULL`,
    [receiptIdSet]
  );
  const receiptOrderById = new Map(
    (
      receiptOrderResult.rows as Array<{
        id: string;
        received_at: string;
        seq: number;
      }>
    ).map((r) => [r.id, r])
  );
  const chronologicalReceiptIds = [...receiptIdSet].sort((a, b) => {
    const ra = receiptOrderById.get(a);
    const rb = receiptOrderById.get(b);
    const ta = ra ? new Date(ra.received_at).getTime() : 0;
    const tb = rb ? new Date(rb.received_at).getTime() : 0;
    if (ta !== tb) return ta - tb;
    return (ra?.seq ?? 0) - (rb?.seq ?? 0);
  });

  // The cost each variant ENDS this confirm at, collected as the replay runs.
  // The window repricing below needs exactly this value — re-reading
  // `average_cost` afterwards would work today but breaks the moment a variant
  // has more than one event in play.
  const finalCostByVariant = new Map<string, number>();

  await Promise.all(
    [...landedByVariant.entries()].map(async ([variantId, { totalLanded, totalQty: receivedQty }]) => {
      const batchLandedPerUnit = receivedQty > 0 ? totalLanded / receivedQty : 0;

      // Per-receipt qty_on_hand_at_receive / qty_received_now for THIS variant,
      // across every receipt in the set. Pre-fix receipts (rare, historical)
      // have no capture — same live-inventory fallback as before, applied
      // per-step (see route docstring / project_qb_editsequence... memory for
      // why the capture-fix predates D6: every receipt eligible for a
      // multi-receipt bill today already carries the capture).
      const stockRes = await knex.raw(
        `SELECT
           rl.purchase_order_receipt_id                     AS receipt_id,
           COALESCE(SUM(rl.qty_on_hand_at_receive)::int, 0)  AS q_before,
           COALESCE(SUM(rl.qty_received_now)::int, 0)        AS q_received,
           BOOL_AND(rl.qty_on_hand_at_receive IS NOT NULL)   AS has_capture
         FROM purchase_order_receipt_line rl
         WHERE rl.purchase_order_receipt_id = ANY(?)
           AND rl.product_variant_id = ?
           AND rl.deleted_at IS NULL
         GROUP BY rl.purchase_order_receipt_id`,
        [receiptIdSet, variantId]
      );
      const stockByReceipt = new Map(
        (
          stockRes.rows as Array<{
            receipt_id: string;
            q_before: number;
            q_received: number;
            has_capture: boolean;
          }>
        ).map((r) => [r.receipt_id, r])
      );

      const contributingReceiptIds = chronologicalReceiptIds.filter((rid) => {
        const r = stockByReceipt.get(rid);
        return r && r.q_received > 0;
      });
      if (contributingReceiptIds.length === 0) return;

      // Live-inventory fallback (pre-capture-fix legacy data only) — read once
      // per variant and reused for any step lacking a capture, same formula
      // the single-receipt path always used.
      let liveQty: number | null = null;
      const needsLiveFallback = contributingReceiptIds.some(
        (rid) => !stockByReceipt.get(rid)?.has_capture
      );
      if (needsLiveFallback) {
        const fallbackRes = await knex.raw(
          `SELECT COALESCE(SUM(il.stocked_quantity)::int, 0) AS qty
           FROM inventory_level il
           JOIN product_variant_inventory_item pvii ON pvii.inventory_item_id = il.inventory_item_id
           WHERE pvii.variant_id = ? AND il.deleted_at IS NULL`,
          [variantId]
        );
        liveQty = (fallbackRes.rows[0] as { qty: number } | undefined)?.qty ?? 0;
      }

      // avg_0 = current stored average (before this bill's replay).
      const metaResult = await knex.raw(
        `SELECT metadata FROM product_variant WHERE id = ? AND deleted_at IS NULL`,
        [variantId]
      );
      const meta = (metaResult.rows[0] as VariantMetadataRow | undefined)?.metadata;
      // Seed the running average from the canonical cost, in descending order
      // of authority (landed state -> average_cost -> QB average -> purchase).
      //
      // This used to read ONLY `avg_landed_cost_cents` and fall back to 0. That
      // key is NULL on a variant's FIRST bill, so every pre-existing unit on
      // the shelf entered the weighted average valued at nothing and collapsed
      // the result: 14 units at $0.00 plus 3 at $14.14 produced $2.50 when
      // QuickBooks said the item was worth $23.55. Nine China SKUs ended up
      // carrying an average cost BELOW their own factory cost that way.
      const { seedCents } = resolveAvgCostSeedCents(
        meta as Record<string, unknown> | null | undefined
      );
      let runningAvg: number | null = seedCents;

      // Aggregates for this variant's cost event, accumulated as the replay
      // runs. `effectiveAt` is the FIRST receipt that contributed — the moment
      // the goods came under our control, which is when the cost attaches.
      let variantEffectiveAt: string | null = null;
      let variantQtyReceived = 0;
      let variantQtyAfter = 0;
      let variantTrueUpCents = 0;
      let variantSettledQty = 0;

      // Chronological AVCO replay — one step per contributing receipt.
      for (const rid of contributingReceiptIds) {
        const r = stockByReceipt.get(rid)!;
        const qtyThisReceipt = r.q_received;
        const qBeforeThisReceipt = r.has_capture
          ? r.q_before
          : (liveQty ?? 0) - qtyThisReceipt;

        // The engine owns the arithmetic — including negative on-hand, where a
        // receipt first SETTLES the oversold units (retro-pricing what was
        // already issued to COGS) and only the remainder joins the average.
        // Feeding a negative quantity straight into the formula shrank the
        // denominator and inflated the cost 3.3x on ESP-SFA50W0830.
        const step = applyReceiptToAvco(runningAvg, {
          quantity: qtyThisReceipt,
          landedUnitCostCents: batchLandedPerUnit,
          quantityOnHandBefore: qBeforeThisReceipt,
        });

        if (step.cogsTrueUpCents !== 0) {
          logger.warn(
            `[vendor-bill ${bill.id}] variant ${variantId}: settled ` +
              `${step.negativeSettledQuantity} oversold units against this receipt; ` +
              `COGS true-up of ${(step.cogsTrueUpCents / 100).toFixed(2)} is NOT in the average ` +
              `and needs an accounting entry.`
          );
        }

        // Write cost log row — used for cancel reversal and audit trail. One
        // row per receipt (D6), not one per variant.
        await knex.raw(
          `INSERT INTO vendor_bill_cost_log
             (vendor_bill_id, product_variant_id, received_qty, landed_unit_cost_cents,
              prev_qty_on_hand, prev_avg_cost_cents, new_avg_cost_cents)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            bill.id,
            variantId,
            qtyThisReceipt,
            batchLandedPerUnit,
            qBeforeThisReceipt,
            step.previousAvgCostCents,
            step.newAvgCostCents,
          ]
        );

        runningAvg = step.newAvgCostCents;

        if (variantEffectiveAt === null) {
          variantEffectiveAt = receiptOrderById.get(rid)?.received_at ?? null;
        }
        variantQtyReceived += qtyThisReceipt;
        variantQtyAfter = step.quantityOnHandAfter;
        variantTrueUpCents += step.cogsTrueUpCents;
        variantSettledQty += step.negativeSettledQuantity;
      }

      // Persist the FINAL running average once per variant. A null here means
      // no receipt contributed (nothing to average) — writing it would blank a
      // perfectly good cost, so skip instead.
      if (runningAvg === null) return;
      finalCostByVariant.set(variantId, runningAvg / 100);

      // Append the cost event. `variant_cost_event` is the reconstructable
      // history of every cost change; the one-off restatement seeded it, and
      // without this write it would stop dead there — future windows would find
      // no later event and reach forward indefinitely.
      //
      // Non-fatal on purpose: the bill is confirmed and its average stored, and
      // an append-only journal must never be the thing that fails a confirm.
      // The idempotency key makes a re-confirm a no-op instead of a duplicate.
      try {
        await knex.raw(
          `INSERT INTO variant_cost_event
             (id, product_variant_id, event_type, cost_field, effective_at, recorded_at,
              previous_unit_cost, new_unit_cost, quantity_on_hand_at_event,
              source_system, source_type, source_id, status, idempotency_key,
              vendor_bill_id, receipt_id, quantity_delta, cogs_true_up_cents,
              negative_settled_quantity, reason_code)
           VALUES (?, ?, 'vendor_bill_receipt', 'average_cost', ?::timestamptz, NOW(),
                   ?::numeric, ?::numeric, ?::int, 'medusa', 'vendor_bill_confirm', ?,
                   'active', ?, ?, ?, ?::int, ?::bigint, ?::int, 'vendor_bill_confirm')
           ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`,
          [
            `vce_cf_${bill.id.slice(-12)}_${variantId.slice(-12)}`,
            variantId,
            variantEffectiveAt ?? new Date().toISOString(),
            seedCents === null ? null : seedCents / 100,
            runningAvg / 100,
            variantQtyAfter,
            bill.id,
            `confirm:${bill.id}:${variantId}`,
            bill.id,
            chronologicalReceiptIds[0] ?? null,
            variantQtyReceived,
            Math.round(variantTrueUpCents),
            variantSettledQty,
          ]
        );
      } catch (error) {
        logger.warn(
          `[vendor-bill ${bill.id}] could not append variant_cost_event for ${variantId}: ` +
            `${error instanceof Error ? error.message : String(error)}. The cost is stored; ` +
            `the history journal is missing this entry.`
        );
      }
      await knex.raw(
        `UPDATE product_variant
         SET metadata = COALESCE(metadata, '{}'::jsonb)
           || jsonb_build_object('avg_landed_cost_cents', ?::float,
                                 'avg_landed_cost_updated_at', now()::text,
                                 'average_cost', (?::float) / 100.0,
                                 'average_cost_updated_at', now()::text,
                                 'average_cost_source', 'landed'),
             updated_at = NOW()
         WHERE id = ?`,
        [runningAvg, runningAvg, variantId]
      );
    })
  );

  // 10b. Reprice the sales that happened between the goods ARRIVING and this
  // bill being confirmed.
  //
  // Those units went out the door from THIS shipment, but they were invoiced
  // before anyone knew what the shipment cost, so their frozen COGS still
  // belongs to the previous one. In production this window averaged 6.4 days
  // (max 20) and had left 224 invoice lines mispriced; without this step every
  // late confirmation opens a fresh one.
  //
  // Non-fatal by the same contract as the QuickBooks enqueue below: the bill is
  // already confirmed and must stand. A failure is loud, and
  // `scripts/fix/recost-vendor-bill-window.ts` re-runs it for a single bill.
  const recostFrom = chronologicalReceiptIds
    .map((rid) => receiptOrderById.get(rid)?.received_at)
    .filter((value): value is string => Boolean(value))
    .map((value) => new Date(value))
    .sort((a, b) => a.getTime() - b.getTime())[0];

  if (recostFrom && finalCostByVariant.size > 0) {
    try {
      // `KnexInstance` above is a deliberately narrow view (raw only); the
      // resolved object is the real knex instance and does have `transaction`,
      // which the repricing needs to keep its writes atomic.
      const recost = await recostSalesWindow(knex as unknown as RecostKnex, {
        costByVariant: finalCostByVariant,
        from: recostFrom,
        // Deterministic: re-confirming the same bill reuses these rows rather
        // than stacking a second correction on top of the first.
        runId: `rw_${bill.id}`,
        reason: "receipt_to_bill_window",
      });
      if (recost.invoiceLinesRepriced + recost.creditMemoLinesRepriced > 0) {
        logger.warn(
          `[vendor-bill ${bill.id}] repriced ${recost.invoiceLinesRepriced} invoice and ` +
            `${recost.creditMemoLinesRepriced} credit-memo lines sold between ` +
            `${recostFrom.toISOString().slice(0, 10)} and this confirm; COGS moved ` +
            `${(recost.cogsDeltaCents / 100).toFixed(2)}. Reports for those days change.`
        );
      }
    } catch (error) {
      logger.warn(
        `[vendor-bill ${bill.id}] receipt-to-confirm repricing FAILED: ` +
          `${error instanceof Error ? error.message : String(error)}. The bill is confirmed ` +
          `and the new average is stored, but sales in the window keep the old cost. ` +
          `Re-run: BILL_ID=${bill.id} medusa exec ./src/scripts/fix/recost-vendor-bill-window.ts`
      );
    }
  }

  // 11. Phase 1.1 — enqueue the QuickBooks BillAdd (plan §5). Non-fatal by
  // contract: the local confirm above is already committed and must stand
  // even if the enqueue fails; flag-gated + China-agent-fenced inside.
  try {
    const enq = await enqueueQbVendorBillAdd(knex, bill.id);
    if (!enq.queued) {
      console.info(
        `[vendor-bill-confirm] QB enqueue skipped for ${bill.id}: ${enq.reason}`
      );
    }
  } catch (enqErr) {
    console.warn(
      `[vendor-bill-confirm] QB enqueue FAILED for ${bill.id}: ${
        enqErr instanceof Error ? enqErr.message : String(enqErr)
      }`
    );
  }

  // 12. Return confirmed bill with updated lines
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
