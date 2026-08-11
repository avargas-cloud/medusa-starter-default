/**
 * src/api/admin/purchase-orders/_lib/validators.ts
 *
 * Zod schemas for Purchase Order request bodies and query filters.
 */

import { z } from "zod";

import { PURCHASE_ORDER_STATUSES } from "../../../../modules/purchase-orders/types";

export const draftLineInputSchema = z.object({
  // Optional: when present on PATCH, matches an existing line for in-place
  // update (preserves qb_txn_line_id so QB Mods don't create ghost lines).
  // Always absent on POST (create).
  id: z.string().min(1).optional(),
  product_variant_id: z.string().min(1, "product_variant_id is required"),
  inventory_item_id: z.string().min(1, "inventory_item_id is required"),
  sku_snapshot: z.string().min(1, "sku_snapshot is required"),
  description_snapshot: z.string().min(1, "description_snapshot is required"),
  qb_item_list_id_snapshot: z.string().min(1).nullish(),
  qty_ordered: z.number().int().nonnegative().max(1_000_000),
  unit_cost_cents: z.number().finite().min(0).max(1_000_000_000),
  tax_cents: z.number().int().min(0).max(1_000_000_000).optional().default(0),
  notes: z.string().max(1000).nullish(),
  line_order: z.number().int().min(0).optional(),
});

export const createDraftSchema = z.object({
  vendor_id: z.string().min(1, "vendor_id is required"),
  stock_location_id: z.string().min(1, "stock_location_id is required"),
  ordered_at: z.string().datetime().nullish(),
  expected_at: z.string().datetime().nullish(),
  memo: z.string().max(2000).nullish(),
  vendor_notes: z.string().max(2000).nullish(),
  reference_number: z.string().max(200).nullish(),
  po_status: z.string().max(100).nullish(),
  linked_order_ids: z.array(z.string()).max(100).nullish(),
  shipping_method: z.string().max(200).nullish(),
  payment_terms: z.string().max(200).nullish(),
  shipping_cents: z.number().int().min(0).optional().default(0),
  tax_cents: z.number().int().min(0).optional().default(0),
  other_fees_cents: z.number().int().min(0).optional().default(0),
  lines: z.array(draftLineInputSchema).max(500).default([]),
});

export const updateDraftSchema = z.object({
  vendor_id: z.string().min(1).optional(),
  stock_location_id: z.string().min(1).optional(),
  ordered_at: z.string().datetime().nullish(),
  expected_at: z.string().datetime().nullish(),
  memo: z.string().max(2000).nullish(),
  vendor_notes: z.string().max(2000).nullish(),
  reference_number: z.string().max(200).nullish(),
  po_status: z.string().max(100).nullish(),
  linked_order_ids: z.array(z.string()).max(100).nullish(),
  shipping_method: z.string().max(200).nullish(),
  payment_terms: z.string().max(200).nullish(),
  shipping_cents: z.number().int().min(0).optional(),
  tax_cents: z.number().int().min(0).optional(),
  other_fees_cents: z.number().int().min(0).optional(),
  lines: z.array(draftLineInputSchema).max(500).optional(),
  // Required only when an edit reduces a line that already participates in a
  // synced/confirmed Vendor Bill. The backend returns the affected lines first
  // so the POS can show a precise confirmation modal.
  confirm_billed_reduction: z.boolean().optional(),
});

export const submitSchema = z.object({});

// ── Tracking ──────────────────────────────────────────────────────────────
// Inbound shipment tracking attached to a PO. Provider/url are computed on the
// frontend (carrier auto-detect lives in lib/tracking.ts); the backend stores
// the snapshot verbatim. tracking_url may be empty for untrackable carriers
// (e.g. ocean freight).

// `lines` carries WHICH goods travel in this shipment. Absent or empty means
// scope 'all_order': the number covers the PO but the quantities were never
// distributed — which is exactly what every pre-existing entry means, and the
// right default for the ordinary one-box PO.
//
// This validates SHAPE only. The cap (a line's allocations across sibling
// trackings may not exceed qty_ordered - qty_cancelled) needs sibling rows, so
// it is enforced in the route inside a transaction. Zod can only catch the
// duplicate-line-id case, which it does — the same line twice in one payload
// would otherwise land as two rows and quietly double the shipment.
const trackingAllocationSchema = z.object({
  purchase_order_line_id: z.string().trim().min(1),
  qty: z.number().int().positive().max(1_000_000),
});

const trackingLinesSchema = z
  .array(trackingAllocationSchema)
  .max(500)
  .refine(
    (lines) =>
      new Set(lines.map((l) => l.purchase_order_line_id)).size === lines.length,
    { message: "The same purchase order line appears more than once." }
  )
  .optional();

const trackingUrlSchema = z
  .string()
  .trim()
  .max(2000)
  .refine(
    (value) => value === "" || /^https?:\/\//i.test(value),
    "tracking_url must use http or https"
  )
  .nullish();

const manualEtaSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "manual_eta must be YYYY-MM-DD")
  .nullish();

const editableTrackingNumberSchema = z.object({
  id: z.string().trim().min(1),
  provider: z.string().trim().min(1).max(50),
  tracking_number: z.string().trim().min(1).max(200),
  tracking_url: trackingUrlSchema,
  manual_eta: manualEtaSchema,
});

export const addTrackingSchema = z.object({
  provider: z.string().trim().min(1).max(50),
  tracking_number: z.string().trim().min(1).max(200),
  tracking_url: trackingUrlSchema,
  manual_eta: manualEtaSchema,
  /** Present → attach this number to an existing delivery instead of creating one. */
  shipment_id: z.string().trim().min(1).optional(),
  lines: trackingLinesSchema,
});

export const updateTrackingSchema = z.object({
  shipment_id: z.string().trim().min(1),
  lines: trackingLinesSchema,
  numbers: z
    .array(editableTrackingNumberSchema)
    .min(1)
    .max(50)
    .refine(
      (numbers) =>
        new Set(numbers.map((number) => number.id)).size === numbers.length,
      { message: "The same tracking number id appears more than once." }
    )
    .optional(),
});

/**
 * Removing a whole delivery (`shipment_id`) frees the quantity it carried;
 * removing one number (`number_id`) leaves the delivery standing. They are
 * different consequences, so the caller must say which one it means.
 */
export const deleteTrackingSchema = z
  .object({
    shipment_id: z.string().trim().min(1).optional(),
    number_id: z.string().trim().min(1).optional(),
  })
  .refine((v) => Boolean(v.shipment_id) !== Boolean(v.number_id), {
    message: "Send exactly one of shipment_id or number_id.",
  });

export const receiveLineSchema = z.object({
  po_line_id: z.string().min(1),
  qty_received_now: z.number().int().positive().max(1_000_000),
  unit_cost_cents_override: z.number().min(0).max(1_000_000_000).nullish(),
});

export const receiveSchema = z.object({
  received_at: z.string().datetime().optional(),
  stock_location_id: z.string().min(1).optional(),
  vendor_bill_number: z.string().max(200).nullish(),
  vendor_bill_date: z.string().datetime().nullish(),
  notes: z.string().max(2000).nullish(),
  qb_memo: z.string().max(200).nullish(),
  lines: z
    .array(receiveLineSchema)
    .min(1, "at least one line is required")
    .max(500),
});

export const closeSchema = z.object({
  close_reason: z
    .string()
    .trim()
    .min(3, "close_reason must be at least 3 characters")
    .max(500),
});

// Used by the PO-level void route (`/admin/purchase-orders/:id/void`).
// Receipt-level void no longer exists — receipts only support hard delete.
export const voidReceiptSchema = z.object({
  void_reason: z
    .string()
    .trim()
    .min(3, "void_reason must be at least 3 characters")
    .max(500),
});

export const deleteReceiptSchema = z.object({
  delete_reason: z
    .string()
    .trim()
    .min(3, "delete_reason must be at least 3 characters")
    .max(500)
    .optional(),
});

export const updateReceiptLineQtySchema = z.object({
  receipt_line_id: z.string().min(1),
  new_qty: z.number().int().min(0),
});

export const updateReceiptSchema = z
  .object({
    vendor_bill_number: z.string().trim().max(100).nullable().optional(),
    line_qty_changes: z.array(updateReceiptLineQtySchema).optional(),
  })
  .refine(
    (v) =>
      v.vendor_bill_number !== undefined ||
      (v.line_qty_changes?.length ?? 0) > 0,
    {
      message:
        "Provide vendor_bill_number or at least one line_qty_changes entry",
    }
  );

export const listQuerySchema = z.object({
  status: z.string().optional(), // CSV of PURCHASE_ORDER_STATUSES entries
  vendor_id: z.string().optional(),
  stock_location_id: z.string().optional(),
  created_by_user_id: z.string().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  q: z.string().optional(), // matches number LIKE
  billed: z.enum(["yes", "no", "partial"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export type DraftLineInput = z.infer<typeof draftLineInputSchema>;
export type CreateDraftInput = z.infer<typeof createDraftSchema>;
export type UpdateDraftInput = z.infer<typeof updateDraftSchema>;
export type ReceiveInput = z.infer<typeof receiveSchema>;
export type ReceiveLineInput = z.infer<typeof receiveLineSchema>;
export type CloseInput = z.infer<typeof closeSchema>;
export type VoidReceiptInput = z.infer<typeof voidReceiptSchema>;
export type DeleteReceiptInput = z.infer<typeof deleteReceiptSchema>;
export type UpdateReceiptInput = z.infer<typeof updateReceiptSchema>;
export type UpdateReceiptLineQty = z.infer<typeof updateReceiptLineQtySchema>;
export type ListQuery = z.infer<typeof listQuerySchema>;
export type AddTrackingInput = z.infer<typeof addTrackingSchema>;
export type UpdateTrackingInput = z.infer<typeof updateTrackingSchema>;
export type DeleteTrackingInput = z.infer<typeof deleteTrackingSchema>;

export const ALLOWED_STATUS_VALUES = PURCHASE_ORDER_STATUSES;
