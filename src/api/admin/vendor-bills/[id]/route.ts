/**
 * src/api/admin/vendor-bills/[id]/route.ts
 *
 * GET    /admin/vendor-bills/:id
 *   Returns the full vendor bill detail with all lines plus PO / receipt
 *   display fields: po_number, receipt_number, vendor_name, receipt.received_at.
 *
 * DELETE /admin/vendor-bills/:id
 *   Hard-deletes a DRAFT vendor bill (and its lines via cascade). Confirmed
 *   bills cannot be deleted because they have already mutated
 *   product_variant.metadata.avg_landed_cost_cents.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { z } from "zod";

import { randomUUID } from "crypto";

import { getActorUserId, UnauthenticatedError } from "../../purchase-orders/_lib/auth";
import { zodErrorToBody } from "../../purchase-orders/_lib/format";
import { recomputeBillFinanceLinks } from "../../../../lib/finance/recompute-bill-finance";
import { verifySupervisorPin } from "../../../../lib/pos/verify-supervisor-pin";
import {
  buildAdjustmentNote,
  diffBillLines,
  type AdjLineState,
} from "../../../../lib/china-finance/bill-adjustment";
import {
  describeDrift,
  loadBillDrift,
  type BillDrift,
} from "../../../../lib/china-finance/bill-drift";
import {
  validateFreightLines,
  reconcileFreightLines,
  type FreightAccount,
} from "../../../../lib/purchase-orders/freight-charge-lines";
import {
  validateTaxCharge,
  reconcileTaxChargeLine,
  type TaxAccount,
} from "../../../../lib/purchase-orders/tax-charge-lines";
import {
  receiptQuantitiesMatchBill,
  resolveBoundReceiptIds,
  resolveReceiptLineUnion,
  syncPrimaryReceiptPointer,
  validateReceiptsForBinding,
} from "../../../../lib/purchase-orders/vendor-bill-receipts";
import {
  findDuplicateVendorBillReference,
  normalizeRequiredVendorBillReference,
  VENDOR_BILL_REFERENCE_REQUIRED_BODY,
} from "../../../../lib/purchase-orders/vendor-bill-reference-uniqueness";
import {
  propagateUnitCostsToPurchaseOrder,
  resolvePoCostChanges,
  type PoLineCostChange,
} from "../../../../lib/purchase-orders/po-cost-propagation";
import type { PurchaseDependencyKnex } from "../../../../lib/purchase-orders/qb-purchase-dependency-chain";

// ── Knex type ────────────────────────────────────────────────────────────────

type KnexInstance = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
  transaction?: () => Promise<
    KnexInstance & { commit: () => Promise<void>; rollback: () => Promise<void> }
  >;
};

function resolveKnex(req: AuthenticatedMedusaRequest): KnexInstance {
  return (req.scope as unknown as { resolve: (k: string) => unknown }).resolve(
    "__pg_connection__"
  ) as KnexInstance;
}

interface VendorBillDetailRow {
  id: string;
  number: string | null;
  purchase_order_id: string | null;
  purchase_order_receipt_id: string | null;
  vendor_id: string | null;
  vendor_name_snapshot: string | null;
  vendor_qb_list_id_snapshot: string | null;
  bill_type: string;
  status: string;
  reference_id: string | null;
  document_date: string | null;
  payment_terms_days: number | null;
  due_date: string | null;
  commission_mode: string;
  commission_rate_bps: number;
  commission_amount_cents: number;
  commission_invoice_number: string | null;
  service_vendor_bill_id: string | null;
  freight_included: boolean;
  freight_amount_cents: number;
  freight_invoice_number: string | null;
  freight_vendor_bill_id: string | null;
  tariff_included: boolean;
  tariff_amount_cents: number;
  tariff_number: string | null;
  tariff_vendor_bill_id: string | null;
  tax_amount_cents: number;
  notes: string | null;
  confirmed_at: string | null;
  confirmed_by_user_id: string | null;
  created_at: string;
  updated_at: string;
  qb_txn_id: string | null;
  qb_amount_due_cents: number | null;
  qb_is_paid: boolean;
  qb_balance_remaining_cents: number | null;
  qb_payment_checked_at: string | null;
  qb_ref_number: string | null;
  qb_synced_at: string | null;
  qb_source: string | null;
  po_number: string | null;
  po_status: string | null;
  po_qb_ref_number: string | null;
  receipt_number: string | null;
  vendor_name: string | null;
  receipt_received_at: string | null;
  ship_to_location_name: string | null;
}

interface VendorBillLineRow {
  id: string;
  vendor_bill_id: string;
  receipt_line_id: string;
  purchase_order_line_id: string | null;
  line_type: string;
  line_kind: string | null;
  qb_txn_line_id: string | null;
  qb_account_list_id: string | null;
  qb_account_full_name: string | null;
  qb_account_type: string | null;
  product_variant_id: string | null;
  /** Hydrated (not stored) — the variant's owning product; see the GET. */
  product_id?: string | null;
  sku: string;
  mpn: string | null;
  description: string;
  qty: number;
  unit_cost_cents: number;
  cbm_per_unit: number | null;
  commission_per_unit_cents: number;
  freight_per_unit_cents: number;
  tariff_per_unit_cents: number;
  landed_unit_cost_cents: number;
  freight_account_list_id: string | null;
  amount_cents: number | null;
}

const vendorBillPatchSchema = z.object({
  vendor_id: z.string().min(1).nullish(),
  bill_type: z.enum(["regular", "service", "freight", "tariff"]).optional(),
  reference_id: z.string().max(200).nullish(),
  document_date: z.string().datetime().nullish(),
  // D9 — Payment Terms + Due Date. Terms default from the vendor's
  // qb_vendor.metadata.default_payment_terms_days; Due Date is overridable.
  // TermsRef is deliberately never sent to QB — see docs/VENDOR_BILL_QB_SYNC_PLAN.md D9.
  payment_terms_days: z.number().int().min(0).max(365).nullish(),
  due_date: z.string().datetime().nullish(),
  commission_mode: z.enum(["percent", "fixed"]).optional(),
  commission_rate_bps: z.number().int().min(0).max(100_000).optional(),
  commission_amount_cents: z.number().int().min(0).max(1_000_000_000).optional(),
  commission_invoice_number: z.string().max(200).nullish(),
  service_vendor_bill_id: z.string().max(200).nullish(),
  freight_included: z.boolean().optional(),
  freight_amount_cents: z.number().int().min(0).max(1_000_000_000).optional(),
  freight_invoice_number: z.string().max(200).nullish(),
  freight_vendor_bill_id: z.string().max(200).nullish(),
  tariff_included: z.boolean().optional(),
  tariff_amount_cents: z.number().int().min(0).max(1_000_000_000).optional(),
  tariff_number: z.string().max(200).nullish(),
  tariff_vendor_bill_id: z.string().max(200).nullish(),
  // Sales tax the vendor charged on THIS invoice. REGULAR bills only — a
  // service/freight/tariff bill is our own reconstruction of a cost pool, not
  // a taxed goods purchase, and is forced back to 0 below.
  tax_amount_cents: z.number().int().min(0).max(1_000_000_000).optional(),
  notes: z.string().max(2000).nullish(),
  clear_lines_for_type_change: z.boolean().optional(),
  // Editing a bill already paid by a CONFIRMED wire is refused by default (the
  // money is gone). A valid supervisor PIN authorises it: the bill's liability
  // drops, the wire application stays immutable, and the delta engine turns the
  // difference into an overpay credit — audited in china_finance_bill_adjustment.
  supervisor_pin: z.string().max(64).optional(),
  adjustment_reason: z.string().max(500).optional(),
  // Staged line edits, persisted together with the header in a SINGLE request
  // (no per-keystroke auto-save). Draft regular bills only.
  line_quantities: z
    .array(
      z.object({
        id: z.string().min(1),
        qty: z.number().int().min(0).max(1_000_000),
      })
    )
    .optional(),
  removed_line_ids: z.array(z.string().min(1)).optional(),
  // Full desired product-line set for a staged save (browser-side editing:
  // qty edits, removals, and Update-From results all resolve to this set).
  // Lines with an `id` update in place; without an `id` they are inserted;
  // existing product lines absent from the set are removed.
  lines: z
    .array(
      z.object({
        id: z.string().optional(),
        purchase_order_line_id: z.string().min(1),
        qty: z.number().int().min(0).max(1_000_000),
        unit_cost_cents: z.number().int().min(0).max(1_000_000_000),
        sku: z.string().max(200),
        description: z.string().max(1000),
        cbm_per_unit: z.number().nullable().optional(),
        mpn: z.string().max(200).nullable().optional(),
        product_variant_id: z.string().nullable().optional(),
      })
    )
    .optional(),
  // Staged receipt pin (Update-From-Receipt); null clears the pin. LEGACY —
  // single-receipt shape, kept for the store-pos UI that hasn't moved to
  // `receipt_ids` yet. Both fields dual-write the same underlying binding
  // (see lib/purchase-orders/vendor-bill-receipts.ts).
  purchase_order_receipt_id: z.string().nullable().optional(),
  // D6 — full DESIRED set of receipts bound to this bill (multi-receipt
  // binding). Reconciled like `lines`: ids present-but-not-yet-bound are
  // bound, ids currently bound but absent from this set are unbound. See
  // docs/VENDOR_BILL_QB_SYNC_PLAN.md §3.0.
  receipt_ids: z.array(z.string().min(1)).optional(),
  // §7 — Freight charge lines ("Add Freight Charges"). Full desired set for a
  // staged save, mirroring `lines` above but for non-landed ExpenseLine-style
  // charges. Deliberately a SEPARATE field from `lines`: freight charges carry
  // no purchase_order_line_id and must never enter the PO qty-cap validation,
  // the landed-cost allocation, or the drift engine (see confirm route + bill-drift.ts).
  freight_lines: z
    .array(
      z.object({
        id: z.string().optional(),
        amount_cents: z.number().int().min(1).max(1_000_000_000),
        freight_account_list_id: z.string().min(1),
        description: z.string().max(500).nullable().optional(),
      })
    )
    .optional(),
});

const LINKED_BILL_TYPE_BY_FIELD: Record<string, string> = {
  service_vendor_bill_id: "service",
  freight_vendor_bill_id: "freight",
  tariff_vendor_bill_id: "tariff",
};

// ── GET ──────────────────────────────────────────────────────────────────────

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const { id } = req.params as { id: string };
  const knex = resolveKnex(req);

  const headerResult = await knex.raw(
    `SELECT
       vb.id,
       vb.number,
       vb.purchase_order_id,
       COALESCE(vb.purchase_order_receipt_id, fallback_por.id) AS purchase_order_receipt_id,
       vb.vendor_id,
       vb.vendor_name_snapshot,
       vb.vendor_qb_list_id_snapshot,
       vb.bill_type,
       vb.status,
       vb.reference_id,
       vb.document_date,
       vb.payment_terms_days,
       vb.due_date,
       vb.commission_mode,
       vb.commission_rate_bps,
       vb.commission_amount_cents,
       vb.commission_invoice_number,
       vb.service_vendor_bill_id,
       vb.freight_included,
       vb.freight_amount_cents,
       vb.freight_invoice_number,
       vb.freight_vendor_bill_id,
       vb.tariff_included,
       vb.tariff_amount_cents,
       vb.tariff_number,
       vb.tariff_vendor_bill_id,
       vb.tax_amount_cents,
       vb.notes,
       vb.confirmed_at,
       vb.confirmed_by_user_id,
       vb.created_at,
       vb.updated_at,
       vb.qb_txn_id,
       vb.qb_amount_due_cents,
       vb.qb_is_paid,
       vb.qb_balance_remaining_cents,
       vb.qb_payment_checked_at,
       vb.qb_ref_number,
       vb.qb_synced_at,
       vb.qb_source,
       po."number"                         AS po_number,
       po.status                           AS po_status,
       po.qb_purchase_order_txn_number      AS po_qb_ref_number,
       COALESCE(por."number", fallback_por."number") AS receipt_number,
       COALESCE(vb.vendor_name_snapshot, po.vendor_name_snapshot) AS vendor_name,
       COALESCE(por.received_at, fallback_por.received_at) AS receipt_received_at,
       sl.name                             AS ship_to_location_name
     FROM vendor_bill vb
     LEFT JOIN purchase_order po
       ON po.id = vb.purchase_order_id AND po.deleted_at IS NULL
     LEFT JOIN purchase_order_receipt por
       ON por.id = vb.purchase_order_receipt_id AND por.deleted_at IS NULL
     LEFT JOIN LATERAL (
       SELECT id, "number", received_at, stock_location_id
       FROM purchase_order_receipt
       WHERE purchase_order_id = po.id
         AND po.status = 'received'
         AND status IN ('applied', 'synced')
         AND deleted_at IS NULL
       ORDER BY received_at ASC
       LIMIT 1
     ) fallback_por ON vb.purchase_order_receipt_id IS NULL
     LEFT JOIN stock_location sl
       ON sl.id = COALESCE(por.stock_location_id, fallback_por.stock_location_id) AND sl.deleted_at IS NULL
     WHERE vb.id = ? AND vb.deleted_at IS NULL`,
    [id]
  );

  const header = (headerResult.rows[0] ?? null) as VendorBillDetailRow | null;
  if (!header) {
    return res
      .status(404)
      .json({ error: "Vendor bill not found", code: "not_found" });
  }

  const linesResult = await knex.raw(
    `SELECT
       id,
       vendor_bill_id,
       receipt_line_id,
       purchase_order_line_id,
       line_type,
       line_kind,
       qb_txn_line_id,
       qb_account_list_id,
       qb_account_full_name,
       qb_account_type,
       product_variant_id,
       sku,
       mpn,
       description,
       qty,
       unit_cost_cents,
       cbm_per_unit,
       commission_per_unit_cents,
       freight_per_unit_cents,
       tariff_per_unit_cents,
       landed_unit_cost_cents,
       freight_account_list_id,
       amount_cents
     FROM vendor_bill_line
     WHERE vendor_bill_id = ? AND deleted_at IS NULL
     ORDER BY created_at ASC`,
    [id]
  );

  const lines = linesResult.rows as VendorBillLineRow[];

  // Owning product of each line's variant. Needed by the POS so a unit-cost
  // edit can offer "also make this the product's permanent purchase cost" —
  // that write is product-scoped (POST /admin/pos/products/:productId), and the
  // bill only stores the variant. Display/action field, never snapshotted.
  const lineVariantIds = [
    ...new Set(
      lines
        .map((l) => l.product_variant_id)
        .filter((v): v is string => !!v)
    ),
  ];
  if (lineVariantIds.length > 0) {
    const productResult = await knex.raw(
      `SELECT id, product_id
         FROM product_variant
        WHERE id = ANY(?)`,
      [lineVariantIds]
    );
    const productByVariant = new Map(
      (productResult.rows as Array<{ id: string; product_id: string | null }>).map(
        (r) => [r.id, r.product_id]
      )
    );
    for (const l of lines) {
      l.product_id = l.product_variant_id
        ? (productByVariant.get(l.product_variant_id) ?? null)
        : null;
    }
  }

  // On opening a DRAFT bill, refresh each line's cbm_per_unit from the current
  // product CBM (source of truth = Freight Specs / product_variant.metadata.cbm),
  // so the draft preview matches what "Confirm & Lock Costs" will lock (confirm
  // reads fresh cbm). Display-only: the stored snapshot is untouched until confirm.
  if (header.status === "draft") {
    const variantIds = [
      ...new Set(
        lines
          .map((l) => l.product_variant_id)
          .filter((v): v is string => !!v)
      ),
    ];
    if (variantIds.length > 0) {
      const cbmResult = await knex.raw(
        `SELECT id, (metadata->>'cbm') AS cbm
           FROM product_variant
          WHERE id IN (${variantIds.map(() => "?").join(",")})`,
        variantIds
      );
      const cbmByVariant = new Map<string, number | null>();
      for (const r of cbmResult.rows as Array<{ id: string; cbm: string | null }>) {
        const n = r.cbm === null ? NaN : parseFloat(r.cbm);
        cbmByVariant.set(r.id, Number.isFinite(n) ? n : null);
      }
      for (const l of lines) {
        if (l.product_variant_id && cbmByVariant.has(l.product_variant_id)) {
          l.cbm_per_unit = cbmByVariant.get(l.product_variant_id) ?? null;
        }
      }
    }
  }

  // Rcv'd column (D8 visibility) — CONTEXT-AWARE:
  //   bill has BOUND receipts → received qty within THE BOUND SET (a partial
  //     bill compares against its own receipts, not the whole PO — otherwise a
  //     2-of-7-receipts bill shows Qty 30 / Rcv'd 60 and reads as wrong);
  //   no bound receipts (Fill-from-PO draft) → the PO line's TOTAL received,
  //     which is exactly the "did the goods arrive yet?" signal D8 wants.
  // Display-only, read live — never snapshotted on the bill.
  {
    const poLineIds = [
      ...new Set(
        lines
          .map((l) => l.purchase_order_line_id)
          .filter((v): v is string => !!v)
      ),
    ];
    if (poLineIds.length > 0) {
      const boundRcvResult = await knex.raw(
        `SELECT rl.purchase_order_line_id AS id,
                SUM(rl.qty_received_now)::int AS qty
           FROM purchase_order_receipt_line rl
           JOIN purchase_order_receipt r ON r.id = rl.purchase_order_receipt_id
          WHERE r.vendor_bill_id = ?
            AND r.deleted_at IS NULL AND rl.deleted_at IS NULL
          GROUP BY rl.purchase_order_line_id`,
        [id]
      );
      const boundRows = boundRcvResult.rows as Array<{
        id: string;
        qty: number | null;
      }>;
      const hasBoundReceipts = boundRows.length > 0;

      let rcvByPoLine: Map<string, number>;
      if (hasBoundReceipts) {
        rcvByPoLine = new Map(boundRows.map((r) => [r.id, Number(r.qty ?? 0)]));
      } else {
        const rcvResult = await knex.raw(
          `SELECT id, qty_received FROM purchase_order_line
            WHERE id IN (${poLineIds.map(() => "?").join(",")})`,
          poLineIds
        );
        rcvByPoLine = new Map(
          (
            rcvResult.rows as Array<{ id: string; qty_received: number | null }>
          ).map((r) => [r.id, Number(r.qty_received ?? 0)])
        );
      }
      for (const l of lines) {
        (l as VendorBillLineRow & { po_qty_received: number | null }).po_qty_received =
          l.purchase_order_line_id
            ? (rcvByPoLine.get(l.purchase_order_line_id) ?? (hasBoundReceipts ? 0 : null))
            : null;
      }
    }
  }

  const total_landed_cents = lines.reduce(
    (s, l) => s + l.landed_unit_cost_cents * l.qty,
    0
  );

  // D9 — the vendor's default payment-terms (days), shown as a placeholder and
  // used to drive the "save as default" prompt when the bill's term diverges.
  // Read LIVE from qb_vendor.metadata (never a snapshot) — the default can be
  // edited from this page and should reflect immediately.
  let vendor_default_payment_terms_days: number | null = null;
  if (header.vendor_id) {
    const vendorMetaResult = await knex.raw(
      `SELECT (metadata->>'default_payment_terms_days')::int AS default_payment_terms_days
         FROM qb_vendor
        WHERE id = ? AND deleted_at IS NULL
        LIMIT 1`,
      [header.vendor_id]
    );
    const vendorMetaRow = vendorMetaResult.rows[0] as
      | { default_payment_terms_days: number | string | null }
      | undefined;
    vendor_default_payment_terms_days =
      vendorMetaRow?.default_payment_terms_days != null
        ? Number(vendorMetaRow.default_payment_terms_days)
        : null;
  }

  // Drift — does this bill still agree with the document it mirrors? Computed by
  // the SHARED engine (lib/china-finance/bill-drift.ts) so this page and the
  // China Finance ledger always give the same verdict. Four rules live there:
  // PO lines, receipt lines (union of the PO's applied receipts — the old check
  // went blind the moment a bill was pinned), agent-commission reconciliation,
  // and freight-vs-declared. Advisory only: never affects save/dirty state.
  //
  // `po_drift` survives as the legacy boolean the amber "Update From…" button
  // reads; it is now true for RECEIPT drift too (the button is also the fix
  // there), but still only on editable (draft regular) bills.
  let po_drift = false;
  let drift: (BillDrift & { message: string }) | null = null;
  try {
    const driftMap = await loadBillDrift(knex, { vendorBillIds: [id] });
    const d = driftMap.get(id);
    if (d) {
      drift = { ...d, message: describeDrift(d) };
      po_drift =
        header.status === "draft" &&
        header.bill_type === "regular" &&
        (d.kind === "po_lines" || d.kind === "receipt_lines");
    }
  } catch (e) {
    // Advisory signal only — a drift failure must never break the bill page.
    console.warn(
      `[vendor-bills] drift check failed for ${id}: ${e instanceof Error ? e.message : e}`
    );
  }

  // D6 — the bound receipt SET + the PO's full bindable pool (with current
  // binding), so the multi-select UI never needs a second round-trip. Dual-
  // read: a receipt counts as "bound to this bill" via the new FK OR the
  // legacy pointer (a bill created before this migration may still only have
  // the legacy column populated for its one receipt).
  let receipts: Array<{
    id: string;
    number: string;
    seq: number;
    received_at: string;
    units: number;
  }> = [];
  let bindable_receipts: Array<{
    id: string;
    number: string;
    seq: number;
    received_at: string;
    units: number;
    bound_to: { bill_id: string; number: string | null } | null;
  }> = [];
  let suggested_receipt_ids: string[] = [];
  if (header.purchase_order_id) {
    const bindableResult = await knex.raw(
      `SELECT por.id, por.number, por.seq, por.received_at,
              COALESCE(SUM(porl.qty_received_now), 0)::int AS units,
              COALESCE(fk_vb.id, legacy_vb.id)         AS bound_bill_id,
              COALESCE(fk_vb.number, legacy_vb.number) AS bound_bill_number
         FROM purchase_order_receipt por
         LEFT JOIN purchase_order_receipt_line porl
           ON porl.purchase_order_receipt_id = por.id AND porl.deleted_at IS NULL
         LEFT JOIN vendor_bill fk_vb
           ON fk_vb.id = por.vendor_bill_id AND fk_vb.deleted_at IS NULL
         LEFT JOIN vendor_bill legacy_vb
           ON legacy_vb.purchase_order_receipt_id = por.id AND legacy_vb.deleted_at IS NULL
        WHERE por.purchase_order_id = ?
          AND por.status IN ('applied', 'synced')
          AND por.deleted_at IS NULL
        GROUP BY por.id, por.number, por.seq, por.received_at,
                 fk_vb.id, fk_vb.number, legacy_vb.id, legacy_vb.number
        ORDER BY por.seq ASC`,
      [header.purchase_order_id]
    );
    type BindableRow = {
      id: string;
      number: string;
      seq: number;
      received_at: string;
      units: number;
      bound_bill_id: string | null;
      bound_bill_number: string | null;
    };
    bindable_receipts = (bindableResult.rows as BindableRow[]).map((r) => ({
      id: r.id,
      number: r.number,
      seq: r.seq,
      received_at: r.received_at,
      units: Number(r.units),
      bound_to: r.bound_bill_id
        ? { bill_id: r.bound_bill_id, number: r.bound_bill_number }
        : null,
    }));
    receipts = bindable_receipts
      .filter((r) => r.bound_to?.bill_id === id)
      .map(({ id: rid, number, seq, received_at, units }) => ({
        id: rid,
        number,
        seq,
        received_at,
        units,
      }));

    // A whole-PO draft intentionally starts without receipt ownership. Suggest
    // every still-unbound applied receipt only when their quantities match the
    // bill exactly by PO line. Anything partial or ambiguous stays unselected
    // and requires an explicit operator choice.
    if (
      header.status === "draft" &&
      header.bill_type === "regular" &&
      receipts.length === 0
    ) {
      const candidateIds = bindable_receipts
        .filter((receipt) => receipt.bound_to === null)
        .map((receipt) => receipt.id);
      if (candidateIds.length > 0) {
        const receiptLines = await resolveReceiptLineUnion(knex, candidateIds);
        const productBillLines = lines
          .filter((line) => line.line_type === "product")
          .map((line) => ({
            purchase_order_line_id: line.purchase_order_line_id,
            qty: line.qty,
          }));
        if (receiptQuantitiesMatchBill(productBillLines, receiptLines)) {
          suggested_receipt_ids = candidateIds;
        }
      }
    }
  }

  // B1 — QuickBooks sync surface (tracker items 1.8/1.10). `qb` is the
  // synced-document identity (null until a BillAdd confirms); `qb_pipeline`
  // is the current `qb_vendor_bill_pipeline` row (one per bill, deleted_at
  // IS NULL — 2026-07-15 one-row-per-document convention), used to render
  // "Syncing…"/"QB retry N"/"QB failed" while the bill hasn't synced yet.
  // The flat qb_txn_id/qb_ref_number/qb_synced_at/qb_source columns stay on
  // `header` too (spread below) — the list route (B2) exposes the same flat
  // shape, so VendorBillSummaryDto stays a true subset of the detail DTO.
  const qb =
    header.qb_txn_id != null
      ? {
          txn_id: header.qb_txn_id,
          ref_number: header.qb_ref_number,
          synced_at: header.qb_synced_at,
          source: header.qb_source,
        }
      : null;

  const pipelineResult = await knex.raw(
    `SELECT status, intent, last_error, retries, updated_at
       FROM qb_vendor_bill_pipeline
      WHERE vendor_bill_id = ? AND deleted_at IS NULL
      LIMIT 1`,
    [id]
  );
  const pipelineRow = (pipelineResult.rows[0] ?? null) as
    | { status: string; intent: string; last_error: string | null; retries: number; updated_at: string }
    | null;
  const qb_pipeline = pipelineRow
    ? {
        status: pipelineRow.status,
        intent: pipelineRow.intent,
        last_error: pipelineRow.last_error,
        retries: Number(pipelineRow.retries ?? 0),
        updated_at: pipelineRow.updated_at,
      }
    : null;

  const revisionsResult = await knex.raw(
    `SELECT r.revision_number, r.status, r.input_hash, r.confirmed_at,
            r.confirmed_by_user_id,
            NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), '') AS confirmed_by_name,
            u.email AS confirmed_by_email
       FROM vendor_bill_revision r
       LEFT JOIN "user" u
         ON u.id = r.confirmed_by_user_id AND u.deleted_at IS NULL
      WHERE r.vendor_bill_id = ?
        AND r.confirmed_at IS NOT NULL
      ORDER BY r.revision_number`,
    [id]
  );
  const revisions = revisionsResult.rows;

  return res.json({
    vendor_bill: {
      ...header,
      total_landed_cents,
      lines,
      po_drift,
      drift,
      vendor_default_payment_terms_days,
      receipts,
      bindable_receipts,
      suggested_receipt_ids,
      qb,
      qb_pipeline,
      revisions,
    },
  });
}

export async function PATCH(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  let actorUserId: string | null = null;
  try {
    actorUserId = getActorUserId(req) ?? null;
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      return res
        .status(err.status)
        .json({ error: err.message, code: err.code });
    }
    throw err;
  }

  const { id } = req.params as { id: string };
  const parsed = vendorBillPatchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(zodErrorToBody(parsed.error));
  }
  const patch = parsed.data;
  // Captured BEFORE the non-regular normalisation below, which writes
  // `tax_amount_cents = 0` into `patch` for every other bill type — after that
  // runs, `"tax_amount_cents" in patch` no longer distinguishes "the caller
  // asked to change the tax" from "we zeroed it ourselves".
  const taxEditRequested = "tax_amount_cents" in patch;
  const knex = resolveKnex(req);

  const lookup = await knex.raw(
    `SELECT id, number, status, bill_type, purchase_order_id, purchase_order_receipt_id,
            vendor_id, reference_id, qb_source, qb_txn_id, tax_amount_cents
       FROM vendor_bill
      WHERE id = ? AND deleted_at IS NULL`,
    [id]
  );
  const bill = (lookup.rows[0] ?? null) as
    | { id: string; number: string | null; status: string; bill_type: string; purchase_order_id: string | null; purchase_order_receipt_id: string | null; vendor_id: string | null; reference_id: string | null; qb_source: string | null; qb_txn_id: string | null; tax_amount_cents: number | string | null }
    | null;
  if (!bill) {
    return res
      .status(404)
      .json({ error: "Vendor bill not found", code: "not_found" });
  }
  // ADOPTED bills remain read-only for accounting content. Payment terms are
  // the one local planning exception: operators may set days and the derived
  // due date without changing the legacy QB document itself.
  if (bill.qb_source === "adopted") {
    const keys = Object.keys(patch);
    const allowedKeys = new Set(["payment_terms_days", "due_date"]);
    if (keys.some((key) => !allowedKeys.has(key))) {
      return res.status(409).json({
        error:
          "This adopted legacy bill is read-only except for local payment terms and due date",
        code: "adopted_bill_readonly",
      });
    }
    if (keys.length === 0) {
      return GET(req, res);
    }
    const entries = keys.map((key) => [
      key,
      patch[key as keyof typeof patch] ?? null,
    ] as const);
    await knex.raw(
      `UPDATE vendor_bill
          SET ${entries.map(([key]) => `${key} = ?`).join(", ")},
              updated_at = NOW()
        WHERE id = ? AND deleted_at IS NULL`,
      [...entries.map(([, value]) => value), id]
    );
    return GET(req, res);
  }
  if (
    bill.status !== "draft" &&
    bill.status !== "confirmed" &&
    bill.status !== "synced"
  ) {
    return res.status(409).json({
      error: `Cannot update a vendor bill in status '${bill.status}'.`,
      code: "not_draft",
    });
  }

  const effectiveReferenceId = normalizeRequiredVendorBillReference(
    "reference_id" in patch ? patch.reference_id : bill.reference_id
  );
  if (!effectiveReferenceId) {
    return res.status(422).json(VENDOR_BILL_REFERENCE_REQUIRED_BODY);
  }
  if ("reference_id" in patch) {
    patch.reference_id = effectiveReferenceId;
  }

  if (patch.vendor_id !== undefined && patch.vendor_id !== null) {
    const vendorResult = await knex.raw(
      `SELECT id, qb_list_id, full_name, name, company_name
       FROM qb_vendor
       WHERE id = ? AND deleted_at IS NULL AND is_active = true
       LIMIT 1`,
      [patch.vendor_id]
    );
    const vendor = (vendorResult.rows[0] ?? null) as
      | {
          id: string;
          qb_list_id: string | null;
          full_name: string | null;
          name: string | null;
          company_name: string | null;
        }
      | null;
    if (!vendor) {
      return res.status(422).json({
        error: "A valid active vendor must be selected",
        code: "vendor_required",
      });
    }
    patch.vendor_id = vendor.id;
    (patch as typeof patch & { vendor_name_snapshot?: string }).vendor_name_snapshot =
      vendor.company_name ?? vendor.full_name ?? vendor.name ?? vendor.id;
    (patch as typeof patch & { vendor_qb_list_id_snapshot?: string | null }).vendor_qb_list_id_snapshot =
      vendor.qb_list_id;
  }

  if (patch.bill_type && patch.bill_type !== bill.bill_type) {
    const linesResult = await knex.raw(
      `SELECT COUNT(*) AS count FROM vendor_bill_line WHERE vendor_bill_id = ? AND deleted_at IS NULL`,
      [id]
    );
    const lineCount = Number((linesResult.rows[0] as { count: string }).count);
    if (lineCount > 0 && !patch.clear_lines_for_type_change) {
      return res.status(409).json({
        error:
          "Changing bill type will remove all existing lines. Confirm clear_lines_for_type_change to continue.",
        code: "type_change_requires_clear",
        line_count: lineCount,
      });
    }
    if (lineCount > 0) {
      await knex.raw(
        `UPDATE vendor_bill_line SET deleted_at = NOW(), updated_at = NOW()
         WHERE vendor_bill_id = ? AND deleted_at IS NULL`,
        [id]
      );
    }
  }

  const effectiveBillType = patch.bill_type ?? bill.bill_type;
  if (effectiveBillType !== "regular") {
    patch.commission_rate_bps = 0;
    patch.commission_amount_cents = 0;
    patch.commission_invoice_number = null;
    patch.service_vendor_bill_id = null;
    patch.freight_included = false;
    patch.freight_amount_cents = 0;
    patch.freight_invoice_number = null;
    patch.freight_vendor_bill_id = null;
    patch.tariff_included = false;
    patch.tariff_amount_cents = 0;
    patch.tariff_number = null;
    patch.tariff_vendor_bill_id = null;
    // Sales tax is a REGULAR-bill concept: a service/freight/tariff bill is our
    // own reconstruction of a cost pool, not a taxed goods purchase. Refuse
    // explicitly rather than silently discarding, so an API caller learns the
    // amount did not stick.
    if (Number(patch.tax_amount_cents ?? 0) > 0) {
      return res.status(422).json({
        error: "Sales tax can only be recorded on a regular vendor bill",
        code: "tax_not_allowed_for_bill_type",
      });
    }
    patch.tax_amount_cents = 0;
  }

  for (const [field, requiredType] of Object.entries(LINKED_BILL_TYPE_BY_FIELD)) {
    const linkedId = patch[field as keyof typeof patch];
    if (linkedId === undefined || linkedId === null || linkedId === "") continue;
    if (linkedId === id) {
      return res.status(422).json({
        error: "A vendor bill cannot be linked to itself",
        code: "self_link",
      });
    }
    const linkedResult = await knex.raw(
      `SELECT id, status, bill_type
       FROM vendor_bill
       WHERE id = ? AND deleted_at IS NULL`,
      [linkedId]
    );
    const linked = (linkedResult.rows[0] ?? null) as
      | { id: string; status: string; bill_type: string }
      | null;
    if (!linked) {
      return res.status(404).json({
        error: `Linked ${requiredType} bill not found`,
        code: "linked_bill_not_found",
      });
    }
    if (linked.bill_type !== requiredType) {
      return res.status(422).json({
        error: `Linked bill must be a ${requiredType} bill`,
        code: "linked_bill_wrong_type",
      });
    }
    if (
      linked.status !== "draft" &&
      linked.status !== "confirmed" &&
      linked.status !== "synced"
    ) {
      return res.status(422).json({
        error: `Linked ${requiredType} bill is not editable`,
        code: "linked_bill_not_open",
      });
    }
  }

  const updatePayload: Record<string, unknown> = {};
  for (const key of [
    "vendor_id",
    "vendor_name_snapshot",
    "vendor_qb_list_id_snapshot",
    "bill_type",
    "reference_id",
    "document_date",
    "payment_terms_days",
    "due_date",
    "commission_mode",
    "commission_rate_bps",
    "commission_amount_cents",
    "commission_invoice_number",
    "service_vendor_bill_id",
    "freight_included",
    "freight_amount_cents",
    "freight_invoice_number",
    "freight_vendor_bill_id",
    "tariff_included",
    "tariff_amount_cents",
    "tariff_number",
    "tariff_vendor_bill_id",
    "tax_amount_cents",
    "notes",
  ]) {
    if (key in patch) {
      updatePayload[key] = patch[key as keyof typeof patch] ?? null;
    }
  }

  // ── Validate staged line edits before any write ─────────────────────────────
  const fullLines = patch.lines;
  const hasFullLines = fullLines !== undefined;
  const qtyEdits = hasFullLines ? [] : patch.line_quantities ?? [];
  const removedIds = hasFullLines ? [] : patch.removed_line_ids ?? [];
  const pinProvided = "purchase_order_receipt_id" in patch;
  const receiptIdsProvided = patch.receipt_ids !== undefined;
  const hasLineEdits = hasFullLines || qtyEdits.length > 0 || removedIds.length > 0;
  // Set by the confirmed-wire gate below; drives the audited-adjustment write.
  let onConfirmedWire = false;

  // Shared PO-line map (caps + new-line snapshots) for the bill's PO.
  const poLineById = new Map<
    string,
    { po_qty: number; product_variant_id: string; sku: string; description: string; metadata: Record<string, unknown> | null }
  >();

  if (hasLineEdits || pinProvided || receiptIdsProvided) {
    if (
      (bill.status !== "draft" && bill.status !== "synced") ||
      effectiveBillType !== "regular"
    ) {
      return res.status(409).json({
        error: "Lines and receipt bindings can only be edited on regular bills",
        code: "not_draft",
      });
    }
    if (!bill.purchase_order_id) {
      return res.status(422).json({ error: "This bill is not linked to a purchase order", code: "no_purchase_order" });
    }
    const confirmedWire = await knex.raw(
      `SELECT 1 FROM china_finance_bill cfb
         JOIN china_wire_transfer_application cwta ON cwta.bill_id = cfb.id
         JOIN china_wire_transfer cwt ON cwt.id = cwta.wire_transfer_id
        WHERE cfb.vendor_bill_id = ? AND cwt.status = 'confirmed' LIMIT 1`,
      [id]
    );
    // Paid by a confirmed wire → the money already moved, so this is no longer a
    // free edit: it lowers the bill's liability while the wire application stays
    // immutable, and the delta engine turns the gap into an overpay CREDIT the
    // agent owes back. Allowed, but only behind a supervisor PIN and always
    // audited (see the adjustment record written after the line writes below).
    onConfirmedWire = confirmedWire.rows.length > 0;
    if (onConfirmedWire) {
      const pinOk = await verifySupervisorPin(knex, patch.supervisor_pin);
      if (!pinOk) {
        return res.status(409).json({
          error: patch.supervisor_pin
            ? "Invalid supervisor PIN"
            : "This bill is already paid by a confirmed wire. A supervisor PIN is required to adjust it — the difference becomes a credit against the agent.",
          code: "on_confirmed_wire_pin_required",
          requires_supervisor_pin: true,
        });
      }
    }

    const polRows = await knex.raw(
      `SELECT pol.id, GREATEST(pol.qty_ordered - COALESCE(pol.qty_cancelled,0),0)::int AS po_qty,
              pol.product_variant_id, pol.sku_snapshot, pol.description_snapshot, pv.metadata
         FROM purchase_order_line pol
         LEFT JOIN product_variant pv ON pv.id = pol.product_variant_id AND pv.deleted_at IS NULL
        WHERE pol.purchase_order_id = ? AND pol.deleted_at IS NULL`,
      [bill.purchase_order_id]
    );
    for (const r of polRows.rows as Array<Record<string, unknown>>) {
      poLineById.set(r.id as string, {
        po_qty: Number(r.po_qty ?? 0),
        product_variant_id: r.product_variant_id as string,
        sku: (r.sku_snapshot as string) ?? "",
        description: (r.description_snapshot as string) ?? "",
        metadata: (r.metadata as Record<string, unknown> | null) ?? null,
      });
    }
  }

  // Staged receipt pin validation.
  if (pinProvided && patch.purchase_order_receipt_id) {
    const rid = patch.purchase_order_receipt_id;
    const rr = await knex.raw(
      `SELECT purchase_order_id, status FROM purchase_order_receipt WHERE id = ? AND deleted_at IS NULL`,
      [rid]
    );
    const rrow = rr.rows[0] as { purchase_order_id: string; status: string } | undefined;
    if (!rrow || rrow.purchase_order_id !== bill.purchase_order_id) {
      return res.status(422).json({ error: "Receipt does not belong to this bill's purchase order", code: "receipt_po_mismatch" });
    }
    if (rrow.status !== "applied" && rrow.status !== "synced") {
      return res.status(422).json({ error: "Receipt is not applied yet", code: "receipt_not_applied" });
    }
    const pinnedElsewhere = await knex.raw(
      `SELECT id FROM vendor_bill WHERE purchase_order_receipt_id = ? AND id <> ? AND deleted_at IS NULL LIMIT 1`,
      [rid, id]
    );
    if (pinnedElsewhere.rows.length > 0) {
      return res.status(409).json({ error: "Another vendor bill is already pinned to this receipt", code: "receipt_already_pinned" });
    }
  }

  // D6 — staged receipt SET reconciliation (full desired set, like `lines`).
  // `receiptIdsToBind`/`receiptIdsToUnbind` are computed here (read-only) and
  // written inside the transaction below, alongside `syncPrimaryReceiptPointer`
  // so the legacy `purchase_order_receipt_id` mirror never drifts.
  let receiptIdsToBind: string[] = [];
  let receiptIdsToUnbind: string[] = [];
  if (receiptIdsProvided) {
    const desired = new Set(patch.receipt_ids!);
    const currentBound = new Set(
      await resolveBoundReceiptIds(knex, id, bill.purchase_order_receipt_id)
    );
    const toBind = [...desired].filter((rid) => !currentBound.has(rid));
    const toUnbind = [...currentBound].filter((rid) => !desired.has(rid));

    if (toBind.length > 0) {
      const validation = await validateReceiptsForBinding(knex, {
        purchaseOrderId: bill.purchase_order_id!,
        billId: id,
        receiptIds: toBind,
      });
      if (!validation.ok) {
        return res.status(validation.status).json(validation.body);
      }
    }
    receiptIdsToBind = toBind;
    receiptIdsToUnbind = toUnbind;
  }

  // Existing product lines on the bill (id → row). sku/qty/unit_cost are carried
  // so an audited adjustment can state exactly what moved ("RM5: 50 → 25").
  type ExistingLine = {
    id: string;
    purchase_order_line_id: string | null;
    qb_txn_line_id: string | null;
    sku: string | null;
    qty: number;
    unit_cost_cents: number;
  };
  let existingProductLines: ExistingLine[] = [];
  if (hasLineEdits) {
    const plResult = await knex.raw(
      `SELECT id, purchase_order_line_id, qb_txn_line_id, sku,
              qty::int AS qty, unit_cost_cents::int AS unit_cost_cents
         FROM vendor_bill_line
        WHERE vendor_bill_id = ? AND deleted_at IS NULL AND COALESCE(line_type,'product') = 'product'`,
      [id]
    );
    existingProductLines = plResult.rows as ExistingLine[];
  }
  const existingById = new Map(existingProductLines.map((l) => [l.id, l]));

  if (hasFullLines) {
    if (!bill.purchase_order_receipt_id && !pinProvided) {
      // Not pinned and staying unpinned — fine (PO-sourced planning bill).
    }
    if (fullLines!.length < 1) {
      return res.status(422).json({ error: "Vendor bill must keep at least one line", code: "last_line" });
    }
    for (const l of fullLines!) {
      const pol = poLineById.get(l.purchase_order_line_id);
      if (!pol) return res.status(422).json({ error: `Line references a PO line not on this bill's purchase order`, code: "bad_po_line", purchase_order_line_id: l.purchase_order_line_id });
      if (l.qty > pol.po_qty) {
        return res.status(422).json({ error: `Max is the PO quantity (${pol.po_qty}) for ${l.sku}. Edit the PO to add more.`, code: "qty_exceeds_po", po_qty: pol.po_qty });
      }
      if (l.id && !existingById.has(l.id)) {
        return res.status(404).json({ error: `Line ${l.id} not found on this bill`, code: "line_not_found" });
      }
    }
  } else if (hasLineEdits) {
    if (bill.purchase_order_receipt_id && bill.status !== "synced") {
      return res.status(409).json({ error: "This bill is pinned to a receipt. Use 'Update from Receipt' to change its lines.", code: "bill_receipt_pinned" });
    }
    for (const edit of qtyEdits) {
      const l = existingById.get(edit.id);
      if (!l) return res.status(404).json({ error: `Line ${edit.id} not found on this bill`, code: "line_not_found" });
      if (!l.purchase_order_line_id) return res.status(422).json({ error: "Cannot determine PO line for the quantity cap", code: "no_po_line", line_id: edit.id });
      const cap = poLineById.get(l.purchase_order_line_id)?.po_qty ?? 0;
      if (edit.qty > cap) {
        return res.status(422).json({ error: `Max is the PO quantity (${cap}). Edit the purchase order to add more.`, code: "qty_exceeds_po", po_qty: cap, line_id: edit.id });
      }
    }
    for (const rid of removedIds) {
      if (!existingById.has(rid)) return res.status(404).json({ error: `Line ${rid} not found on this bill`, code: "line_not_found" });
    }
    if (existingProductLines.length - new Set(removedIds).size < 1) {
      return res.status(422).json({ error: "Vendor bill must keep at least one line", code: "last_line" });
    }
  }

  // A receipt-bound Bill must always stay at or below applied receipt qty.
  // `qb_txn_id` covers a synced Bill whose local status was moved back to
  // draft; the receipt predicates also keep the guard active after a reviewed
  // rebuild has removed the old QB identity but before the operator Reconfirms.
  // Truly receipt-less planning drafts may still mirror a not-yet-received PO.
  if (
    hasLineEdits &&
    (bill.qb_txn_id ||
      bill.purchase_order_receipt_id ||
      receiptIdsProvided)
  ) {
    const desiredByPoLine = new Map<string, number>();
    if (hasFullLines) {
      for (const line of fullLines!) {
        desiredByPoLine.set(
          line.purchase_order_line_id,
          (desiredByPoLine.get(line.purchase_order_line_id) ?? 0) + line.qty
        );
      }
    } else {
      const removed = new Set(removedIds);
      const qtyById = new Map(qtyEdits.map((line) => [line.id, line.qty]));
      for (const line of existingProductLines) {
        if (!line.purchase_order_line_id || removed.has(line.id)) continue;
        desiredByPoLine.set(
          line.purchase_order_line_id,
          (desiredByPoLine.get(line.purchase_order_line_id) ?? 0) +
            (qtyById.get(line.id) ?? line.qty)
        );
      }
    }
    const received = await knex.raw(
      `SELECT porl.purchase_order_line_id,
              SUM(porl.qty_received_now)::int AS qty_received
         FROM purchase_order_receipt por
         JOIN purchase_order_receipt_line porl
           ON porl.purchase_order_receipt_id = por.id
          AND porl.deleted_at IS NULL
        WHERE (por.vendor_bill_id = ?
            OR por.id = (
              SELECT purchase_order_receipt_id
                FROM vendor_bill
               WHERE id = ?
            )
            OR por.id = ANY(?))
          AND por.deleted_at IS NULL
          AND por.status IN ('applied', 'synced')
        GROUP BY porl.purchase_order_line_id`,
      [id, id, patch.receipt_ids ?? []]
    );
    const receivedByPoLine = new Map(
      (received.rows as Array<{
        purchase_order_line_id: string;
        qty_received: number | string;
      }>).map((row) => [
        row.purchase_order_line_id,
        Number(row.qty_received),
      ])
    );
    for (const [poLineId, desiredQty] of desiredByPoLine) {
      const receivedQty = receivedByPoLine.get(poLineId) ?? 0;
      if (desiredQty > receivedQty) {
        return res.status(422).json({
          error:
            `Cannot bill ${desiredQty} units; only ${receivedQty} were received`,
          code: "qty_exceeds_received",
          purchase_order_line_id: poLineId,
          qty_received: receivedQty,
        });
      }
    }
  }

  // ── §7 — Freight charge lines: independent staged reconcile ─────────────────
  // Deliberately kept OUT of `lines`/`line_quantities` above: freight charges
  // have no purchase_order_line_id and no qty, so they never enter the PO
  // qty-cap validation. They are also excluded from landed-cost allocation
  // (see the confirm route, which only feeds `line_type='product'` lines into
  // computeLandedLines) and from the drift engine (bill-drift.ts scopes its
  // comparisons to line_kind <> 'freight_charge'). Validation + reconcile live
  // in lib/purchase-orders/freight-charge-lines.ts — shared shape, kept out of
  // this already-large route file.
  const fullFreightLines = patch.freight_lines;
  const hasFreightLines = fullFreightLines !== undefined;
  let existingFreightIds = new Set<string>();
  let freightAccountByListId = new Map<string, FreightAccount>();

  if (hasFreightLines) {
    if (
      (bill.status !== "draft" && bill.status !== "synced") ||
      effectiveBillType !== "regular"
    ) {
      return res.status(409).json({
        error: "Freight charges can only be edited on regular POS-owned bills",
        code: "not_draft",
      });
    }
    const freightValidation = await validateFreightLines(knex, id, fullFreightLines!);
    if (!freightValidation.ok) {
      return res
        .status(freightValidation.error.status)
        .json(freightValidation.error.body);
    }
    existingFreightIds = freightValidation.existingIds;
    freightAccountByListId = freightValidation.accountByListId;
  }

  // Sales tax — resolve the COGS account BEFORE any write. Failing here (the
  // account does not exist in QuickBooks yet) is a 422 the operator can act on;
  // letting the save through would only defer the failure to the QB enqueue,
  // where it becomes an invisible un-synced bill.
  const hasTaxEdit = taxEditRequested;
  const effectiveTaxCents = hasTaxEdit
    ? Number(patch.tax_amount_cents ?? 0)
    : Number(bill.tax_amount_cents ?? 0);
  let taxAccount: TaxAccount | null = null;
  if (hasTaxEdit) {
    const taxValidation = await validateTaxCharge(knex, effectiveTaxCents);
    if (!taxValidation.ok) {
      return res
        .status(taxValidation.error.status)
        .json(taxValidation.error.body);
    }
    taxAccount = taxValidation.account;
  }

  // ── Unit-cost corrections that must reach the purchase order ────────────────
  // The vendor's invoice is the authoritative price document: repricing a line
  // here reprices the PO line it came from (and its QuickBooks PurchaseOrder),
  // otherwise the drift engine reports a permanent mismatch against a bill that
  // is, in fact, correct. Selection rules live in resolvePoCostChanges.
  const poCostChanges: PoLineCostChange[] =
    hasFullLines && bill.purchase_order_id
      ? resolvePoCostChanges(
          fullLines!,
          new Map(existingProductLines.map((l) => [l.id, l.unit_cost_cents]))
        )
      : [];

  // ── Apply header + staged line edits + recompute in ONE transaction ─────────
  const trx = knex.transaction ? await knex.transaction() : null;
  const db = trx ?? knex;
  try {
    const duplicate = await findDuplicateVendorBillReference(db, {
      vendorId:
        typeof updatePayload.vendor_id === "string"
          ? updatePayload.vendor_id
          : bill.vendor_id,
      referenceId:
        typeof updatePayload.reference_id === "string"
          ? updatePayload.reference_id
          : updatePayload.reference_id === null
            ? null
            : bill.reference_id,
      excludeBillId: id,
    });
    if (duplicate) {
      if (trx) await trx.rollback();
      return res.status(409).json({
        error: `Purchase Invoice '${String(updatePayload.reference_id ?? bill.reference_id).trim()}' already exists for this vendor on ${duplicate.number ?? "an adopted bill"}.`,
        code: "duplicate_vendor_invoice",
        duplicate_vendor_bill_id: duplicate.id,
        duplicate_vendor_bill_number: duplicate.number,
      });
    }

    // Staged receipt pin (Update-From-Receipt) — write with the header set.
    if (pinProvided) {
      updatePayload.purchase_order_receipt_id = patch.purchase_order_receipt_id ?? null;
    }
    const entries = Object.entries(updatePayload);
    if (entries.length > 0) {
      const assignments = entries.map(([key]) => `${key} = ?`).join(", ");
      const values = entries.map(([, value]) => value);
      await db.raw(
        `UPDATE vendor_bill SET ${assignments}, updated_at = NOW()
          WHERE id = ? AND deleted_at IS NULL`,
        [...values, id]
      );
    }

    // D6 — dual-write the new receipt-side FK. `syncPrimaryReceiptPointer`
    // (called once at the end, whichever path ran) recomputes the legacy
    // `vendor_bill.purchase_order_receipt_id` mirror from the LIVE bound set,
    // so it always wins over whatever the plain header UPDATE above wrote.
    if (pinProvided) {
      const newPinId = patch.purchase_order_receipt_id ?? null;
      const oldPinId = bill.purchase_order_receipt_id ?? null;
      if (oldPinId && oldPinId !== newPinId) {
        // Unbind the previous legacy pin — but ONLY if it still points at
        // this bill, so a stale/racy pin never steals another bill's receipt.
        await db.raw(
          `UPDATE purchase_order_receipt SET vendor_bill_id = NULL, updated_at = NOW()
            WHERE id = ? AND vendor_bill_id = ? AND deleted_at IS NULL`,
          [oldPinId, id]
        );
      }
      if (newPinId) {
        await db.raw(
          `UPDATE purchase_order_receipt SET vendor_bill_id = ?, updated_at = NOW()
            WHERE id = ? AND deleted_at IS NULL`,
          [id, newPinId]
        );
      }
    }
    if (receiptIdsProvided) {
      if (receiptIdsToUnbind.length > 0) {
        await db.raw(
          `UPDATE purchase_order_receipt SET vendor_bill_id = NULL, updated_at = NOW()
            WHERE id = ANY(?) AND vendor_bill_id = ? AND deleted_at IS NULL`,
          [receiptIdsToUnbind, id]
        );
      }
      if (receiptIdsToBind.length > 0) {
        await db.raw(
          `UPDATE purchase_order_receipt SET vendor_bill_id = ?, updated_at = NOW()
            WHERE id = ANY(?) AND deleted_at IS NULL`,
          [id, receiptIdsToBind]
        );
      }
    }
    if (pinProvided || receiptIdsProvided) {
      await syncPrimaryReceiptPointer(db, id);
    }

    if (hasFullLines) {
      const keepIds = new Set(fullLines!.filter((l) => l.id).map((l) => l.id as string));
      // Remove existing product lines absent from the set.
      const toRemove = existingProductLines.filter((l) => !keepIds.has(l.id)).map((l) => l.id);
      if (toRemove.length > 0) {
        await db.raw(
          `UPDATE vendor_bill_line SET deleted_at = NOW(), updated_at = NOW()
            WHERE id = ANY(?) AND vendor_bill_id = ? AND deleted_at IS NULL`,
          [toRemove, id]
        );
      }
      for (const l of fullLines!) {
        const pol = poLineById.get(l.purchase_order_line_id)!;
        const cbm = l.cbm_per_unit ?? null;
        if (l.id) {
          await db.raw(
            `UPDATE vendor_bill_line
                SET qty = ?, unit_cost_cents = ?, cbm_per_unit = ?::float, mpn = ?,
                    commission_per_unit_cents = 0, freight_per_unit_cents = 0,
                    tariff_per_unit_cents = 0, tax_per_unit_cents = 0, landed_unit_cost_cents = 0, updated_at = NOW()
              WHERE id = ? AND vendor_bill_id = ? AND deleted_at IS NULL`,
            [l.qty, l.unit_cost_cents, cbm, l.mpn ?? null, l.id, id]
          );
        } else {
          // New line — derive identity fields authoritatively from the PO line.
          await db.raw(
            `INSERT INTO vendor_bill_line (
               id, vendor_bill_id, receipt_line_id, purchase_order_line_id, line_type, line_kind,
               product_variant_id, sku, mpn, description, qty, unit_cost_cents, cbm_per_unit,
               commission_per_unit_cents, freight_per_unit_cents, tariff_per_unit_cents,
               landed_unit_cost_cents, created_at, updated_at)
             VALUES (?, ?, NULL, ?, 'product', 'po_item', ?, ?, ?, ?, ?, ?, ?::float, 0, 0, 0, 0, NOW(), NOW())`,
            [
              `vbl_${randomUUID().replace(/-/g, "")}`,
              id,
              l.purchase_order_line_id,
              pol.product_variant_id,
              pol.sku,
              l.mpn ?? (typeof pol.metadata?.mpn === "string" ? pol.metadata.mpn : null),
              pol.description,
              l.qty,
              l.unit_cost_cents,
              cbm,
            ]
          );
        }
      }
    } else {
      for (const edit of qtyEdits) {
        await db.raw(
          `UPDATE vendor_bill_line
              SET qty = ?, commission_per_unit_cents = 0, freight_per_unit_cents = 0,
                  tariff_per_unit_cents = 0, tax_per_unit_cents = 0, landed_unit_cost_cents = 0, updated_at = NOW()
            WHERE id = ? AND vendor_bill_id = ? AND deleted_at IS NULL`,
          [edit.qty, edit.id, id]
        );
      }
      if (removedIds.length > 0) {
        await db.raw(
          `UPDATE vendor_bill_line SET deleted_at = NOW(), updated_at = NOW()
            WHERE id = ANY(?) AND vendor_bill_id = ? AND deleted_at IS NULL`,
          [removedIds, id]
        );
      }
    }

    // Freight charge lines — full desired set, reconciled independently of the
    // product lines above (add/update/remove by id). See
    // lib/purchase-orders/freight-charge-lines.ts for why this line's dollar
    // value flows into total_landed_cents / recomputeBillFinanceLinks like a
    // product line's cost does, while being skipped entirely by the confirm
    // route's landed-cost allocation and by the drift engine.
    if (hasFreightLines) {
      await reconcileFreightLines(
        db,
        id,
        fullFreightLines!,
        existingFreightIds,
        freightAccountByListId
      );
    }

    // Sales tax charge line — materialized from the header amount so it can
    // reach QuickBooks as an ExpenseLine and be RETAINED by TxnLineID on a
    // later BillMod. Runs before the finance recompute because the tax is real
    // money owed on this bill (it feeds SUM(unit_cost_cents × qty)).
    if (hasTaxEdit) {
      await reconcileTaxChargeLine(db, id, effectiveTaxCents, taxAccount);
    }

    if (hasLineEdits || hasFreightLines || hasTaxEdit) {
      const recompute = await recomputeBillFinanceLinks(db, id);
      if (!recompute.ok) {
        if (trx) await trx.rollback();
        return res.status(409).json({ error: recompute.message, code: recompute.code, conflicts: recompute.conflicts });
      }
    }

    // Audited adjustment of an already-PAID bill. The credit stays DERIVED
    // (applied_cents − amount_cents, produced by the delta engine on the next
    // China Finance sync); this row is the provenance that explains it.
    if (onConfirmedWire && hasLineEdits) {
      const beforeState: AdjLineState[] = existingProductLines.map((l) => ({
        id: l.id,
        sku: l.sku,
        qty: Number(l.qty),
        unit_cost_cents: Number(l.unit_cost_cents),
      }));
      const removedSet = new Set(removedIds);
      const qtyById = new Map(qtyEdits.map((e) => [e.id, e.qty]));
      const afterState: AdjLineState[] = hasFullLines
        ? fullLines!.map((l) => ({
            id: l.id ?? null,
            sku: l.sku ?? poLineById.get(l.purchase_order_line_id)?.sku ?? null,
            qty: l.qty,
            unit_cost_cents: l.unit_cost_cents,
          }))
        : beforeState
            .filter((l) => !removedSet.has(l.id as string))
            .map((l) => ({ ...l, qty: qtyById.get(l.id as string) ?? l.qty }));

      const changes = diffBillLines(beforeState, afterState);
      const previousTotalCents = beforeState.reduce(
        (n, l) => n + l.qty * l.unit_cost_cents,
        0
      );
      const newTotalCents = afterState.reduce(
        (n, l) => n + l.qty * l.unit_cost_cents,
        0
      );

      if (changes.length > 0 && previousTotalCents !== newTotalCents) {
        const cfbRows = await db.raw(
          `SELECT id FROM china_finance_bill WHERE vendor_bill_id = ? LIMIT 1`,
          [id]
        );
        const cfbId =
          (cfbRows.rows[0] as { id?: string } | undefined)?.id ?? null;
        const note = buildAdjustmentNote({
          changes,
          previousTotalCents,
          newTotalCents,
          billNumber: bill.number,
          sourceLabel: bill.purchase_order_receipt_id ? "the receipt" : "the purchase order",
          reason: patch.adjustment_reason ?? null,
        });
        await db.raw(
          `INSERT INTO china_finance_bill_adjustment
             (id, vendor_bill_id, china_finance_bill_id, previous_total_cents,
              new_total_cents, delta_cents, line_changes, note, reason, created_by_user_id)
           VALUES (?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?)`,
          [
            `cfba_${randomUUID().replace(/-/g, "")}`,
            id,
            cfbId,
            previousTotalCents,
            newTotalCents,
            newTotalCents - previousTotalCents,
            JSON.stringify(changes),
            note,
            patch.adjustment_reason ?? null,
            actorUserId,
          ]
        );
      }
    }

    if (bill.bill_type === "regular" && bill.purchase_order_id) {
      const linkedIds = [
        patch.service_vendor_bill_id,
        patch.freight_vendor_bill_id,
        patch.tariff_vendor_bill_id,
      ].filter((linkedId): linkedId is string => typeof linkedId === "string" && linkedId.length > 0);

      if (linkedIds.length > 0) {
        await db.raw(
          `UPDATE vendor_bill
             SET purchase_order_id = ?, updated_at = NOW()
            WHERE id = ANY(?)
              AND deleted_at IS NULL
              AND bill_type IN ('service', 'freight', 'tariff')`,
          [bill.purchase_order_id, linkedIds]
        );
      }
    }

    // Editing a synced bill creates a draft replacement. Do not enqueue
    // BillMod on Save: average costs and QuickBooks move together only when
    // the operator explicitly reconfirms the revision.
    if (
      bill.status === "synced" &&
      (entries.length > 0 || hasLineEdits || hasFreightLines)
    ) {
      await db.raw(
        `UPDATE vendor_bill
            SET status = 'draft',
                draft_revision_number = COALESCE((
                  SELECT MAX(revision_number) + 1
                    FROM vendor_bill_revision
                   WHERE vendor_bill_id = ?
                ), 2),
                updated_at = NOW()
          WHERE id = ? AND status = 'synced'`,
        [id, id]
      );
    }

    // Repriced PO lines + their PurchaseOrderMod, inside the SAME transaction:
    // a rolled-back bill save must never leave a repriced purchase order (or a
    // queued QB operation) behind. Runs last so the QB chain appends the PO Mod
    // after anything else this save enqueued.
    if (poCostChanges.length > 0) {
      await propagateUnitCostsToPurchaseOrder(
        db as unknown as PurchaseDependencyKnex,
        bill.purchase_order_id!,
        poCostChanges
      );
    }

    if (trx) await trx.commit();
  } catch (err) {
    if (trx) await trx.rollback();
    throw err;
  }

  return GET(req, res);
}

// ── DELETE — soft delete, draft only ─────────────────────────────────────────
//
// The row and its VB-#### survive as `status='deleted'`. Removing the row threw
// the number away: the sequence never reuses one, so the document just vanished
// from the series with nothing to explain the gap.
//
// `deleted_at` is stamped too, so every query that already ends in
// `deleted_at IS NULL` — billed-status maths, receipt binding, drift, duplicate
// reference — drops the bill without needing a status filter of its own.

export async function DELETE(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const { id } = req.params as { id: string };
  const knex = resolveKnex(req);

  const lookup = (await knex.raw(
    `SELECT id, number, status, bill_type, qb_txn_id
       FROM vendor_bill WHERE id = ? AND deleted_at IS NULL`,
    [id]
  )) as {
    rows: Array<{
      id: string;
      number: string | null;
      status: string;
      bill_type: string;
      qb_txn_id: string | null;
    }>;
  };

  const existing = lookup.rows[0] ?? null;
  if (!existing) {
    return res
      .status(404)
      .json({ error: "Vendor bill not found", code: "not_found" });
  }

  if (existing.status !== "draft") {
    return res.status(409).json({
      error:
        "Only draft vendor bills can be deleted — confirmed bills have already affected variant landed-cost averages.",
      code: "not_draft",
    });
  }

  // A REOPENED bill is 'draft' again but is not a blank one: Reopen is an
  // editing-state transition that deliberately leaves the confirmed generation
  // standing — its QuickBooks Bill, its posted AVCO/COGS and its immutable
  // revisions all survive. Deleting it would strand a live Bill in QuickBooks
  // with an AP balance nothing local answers for, and leave variant_cost_event
  // (the canonical cost source) pointing at a bill that no longer exists.
  // Cancel reverses those facts; delete never did.
  if (existing.qb_txn_id) {
    return res.status(409).json({
      error:
        "This bill still exists in QuickBooks. Cancel it instead — deleting it here would leave the QuickBooks Bill behind with a balance nothing local answers for.",
      code: "bill_in_quickbooks",
      qb_txn_id: existing.qb_txn_id,
    });
  }
  const postedResult = await knex.raw(
    `SELECT
       (SELECT COUNT(*) FROM vendor_bill_revision WHERE vendor_bill_id = ?)::int AS revisions,
       (SELECT COUNT(*) FROM variant_cost_event WHERE vendor_bill_id = ?)::int AS cost_events`,
    [id, id]
  );
  const posted = postedResult.rows[0] as {
    revisions: number;
    cost_events: number;
  };
  if (posted.revisions > 0 || posted.cost_events > 0) {
    return res.status(409).json({
      error:
        "This bill was confirmed once already, so it has posted costs behind it. Cancel it instead — cancelling replays the cost timeline, deleting would leave those costs applied with no bill to explain them.",
      code: "bill_has_posted_costs",
      revisions: posted.revisions,
      cost_events: posted.cost_events,
    });
  }

  // A secondary bill is a cost POOL of the regular bill that points at it
  // (service_/freight_/tariff_vendor_bill_id — plain columns, no FK, no
  // cascade). Deleting it would leave that pointer dangling and the parent's
  // pool would silently resolve to zero, quietly lowering its landed cost.
  if (existing.bill_type !== "regular") {
    const linkedResult = await knex.raw(
      `SELECT id, number
         FROM vendor_bill
        WHERE deleted_at IS NULL
          AND (service_vendor_bill_id = ? OR freight_vendor_bill_id = ?
               OR tariff_vendor_bill_id = ?)`,
      [id, id, id]
    );
    const linked = linkedResult.rows as Array<{
      id: string;
      number: string | null;
    }>;
    if (linked.length > 0) {
      const names = linked.map((b) => b.number ?? b.id).join(", ");
      return res.status(409).json({
        error: `This ${existing.bill_type} bill is linked as a cost pool on ${names}. Unlink it there first — deleting it would silently drop that cost from the regular bill.`,
        code: "linked_to_regular_bill",
        linked_bills: linked,
      });
    }
  }

  // Safe delete (Phase 4): china_finance_bill.vendor_bill_id has NO cascade, so a
  // naive DELETE hits a 23503 FK violation. Walk the finance links transactionally
  // with row locks: block if any application is on a CONFIRMED wire (real money),
  // otherwise shrink the affected SCHEDULED wires (delta-aware) and remove the
  // cfb rows (their applications cascade) before deleting the bill.
  const trx = knex.transaction ? await knex.transaction() : null;
  const db = trx ?? knex;
  try {
    // Re-lock the bill inside the transaction and re-check draft.
    const locked = (await db.raw(
      `SELECT id, status FROM vendor_bill WHERE id = ? AND deleted_at IS NULL FOR UPDATE`,
      [id]
    )) as { rows: Array<{ id: string; status: string }> };
    if (!locked.rows[0]) {
      if (trx) await trx.rollback();
      return res.status(404).json({ error: "Vendor bill not found", code: "not_found" });
    }
    if (locked.rows[0].status !== "draft") {
      if (trx) await trx.rollback();
      return res.status(409).json({
        error: "Only draft vendor bills can be deleted",
        code: "not_draft",
      });
    }

    // Lock the cfb rows for this bill.
    const cfbRows = (await db.raw(
      `SELECT id FROM china_finance_bill
        WHERE vendor_bill_id = ? FOR UPDATE`,
      [id]
    )) as { rows: Array<{ id: string }> };
    const cfbIds = cfbRows.rows.map((r) => r.id);

    if (cfbIds.length > 0) {
      // Lock applications + their wires; capture status + applied_cents.
      const appRows = (await db.raw(
        `SELECT cwta.id AS application_id, cwta.applied_cents,
                cwta.wire_transfer_id, cwt.status AS wire_status
           FROM china_wire_transfer_application cwta
           JOIN china_wire_transfer cwt ON cwt.id = cwta.wire_transfer_id
          WHERE cwta.bill_id = ANY(?)
          FOR UPDATE`,
        [cfbIds]
      )) as {
        rows: Array<{
          application_id: string;
          applied_cents: number;
          wire_transfer_id: string;
          wire_status: string;
        }>;
      };

      const onConfirmed = appRows.rows.filter((a) => a.wire_status === "confirmed");
      if (onConfirmed.length > 0) {
        if (trx) await trx.rollback();
        return res.status(409).json({
          error:
            "This bill is paid by a confirmed wire transfer. Reverse the payment before deleting.",
          code: "on_confirmed_wire",
        });
      }

      // Shrink each scheduled wire by the applications we're about to remove
      // (delta-aware; preserves any surplus). Applications cascade-delete with cfb.
      const shrinkByWire = new Map<string, number>();
      for (const a of appRows.rows) {
        shrinkByWire.set(
          a.wire_transfer_id,
          (shrinkByWire.get(a.wire_transfer_id) ?? 0) + Number(a.applied_cents)
        );
      }
      for (const [wireId, amount] of shrinkByWire.entries()) {
        await db.raw(
          `UPDATE china_wire_transfer
              SET wire_amount_cents = GREATEST(wire_amount_cents - ?, 0),
                  updated_at = now()
            WHERE id = ?`,
          [amount, wireId]
        );
      }

      // Delete cfb rows (china_wire_transfer_application cascades from cfb).
      await db.raw(`DELETE FROM china_finance_bill WHERE id = ANY(?)`, [cfbIds]);
    }

    // D6 — release every receipt bound to this bill. `vendor_bill_id` on the
    // receipt has no cascade and, more to the point, the bill row now SURVIVES:
    // leaving the pointer would keep those receipts "already billed" against a
    // deleted document, so `validateReceiptsForBinding` would reject them for
    // every future bill forever.
    await db.raw(
      `UPDATE purchase_order_receipt SET vendor_bill_id = NULL, updated_at = NOW()
        WHERE vendor_bill_id = ? AND deleted_at IS NULL`,
      [id]
    );

    // The QuickBooks queue row is per-bill and never cascaded. Nothing reached
    // QB (guarded above on qb_txn_id), so anything queued must not outlive the
    // document that produced it.
    await db.raw(
      `DELETE FROM qb_vendor_bill_pipeline WHERE vendor_bill_id = ?`,
      [id]
    );

    // Soft delete: the row and its number stay, the document stops existing
    // everywhere. Lines are marked too so a stray join without a bill-side
    // filter cannot resurrect them.
    await db.raw(
      `UPDATE vendor_bill_line SET deleted_at = NOW(), updated_at = NOW()
        WHERE vendor_bill_id = ? AND deleted_at IS NULL`,
      [id]
    );
    await db.raw(
      `UPDATE vendor_bill
          SET status = 'deleted', deleted_at = NOW(), updated_at = NOW()
        WHERE id = ? AND deleted_at IS NULL`,
      [id]
    );

    if (trx) await trx.commit();
  } catch (err) {
    if (trx) await trx.rollback();
    throw err;
  }

  return res.json({
    id,
    number: existing.number,
    deleted: true,
    hard: false,
    status: "deleted",
  });
}
