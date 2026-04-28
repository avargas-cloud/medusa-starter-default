import { z } from "zod";

import { FACTORY_ORDER_STATUSES } from "../../../../modules/factory-orders/types";

// No qb_item_list_id_snapshot — factory orders have no QB integration
export const draftLineInputSchema = z.object({
  product_variant_id: z.string().min(1, "product_variant_id is required"),
  inventory_item_id: z.string().min(1, "inventory_item_id is required"),
  sku_snapshot: z.string().min(1, "sku_snapshot is required"),
  description_snapshot: z.string().min(1, "description_snapshot is required"),
  qty_ordered: z.number().int().positive().max(1_000_000),
  unit_cost_cents: z.number().int().min(0).max(1_000_000_000),
  tax_cents: z.number().int().min(0).max(1_000_000_000).optional().default(0),
  notes: z.string().max(1000).nullish(),
  line_order: z.number().int().min(0).optional(),
});

// No stock_location_id — always China Warehouse (hardcoded in handler)
export const createDraftSchema = z.object({
  vendor_id: z.string().min(1, "vendor_id is required"),
  ordered_at: z.string().datetime().nullish(),
  expected_at: z.string().datetime().nullish(),
  memo: z.string().max(2000).nullish(),
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

// No stock_location_id — locked to China Warehouse
export const updateDraftSchema = z.object({
  vendor_id: z.string().min(1).optional(),
  ordered_at: z.string().datetime().nullish(),
  expected_at: z.string().datetime().nullish(),
  memo: z.string().max(2000).nullish(),
  reference_number: z.string().max(200).nullish(),
  po_status: z.string().max(100).nullish(),
  linked_order_ids: z.array(z.string()).max(100).nullish(),
  shipping_method: z.string().max(200).nullish(),
  payment_terms: z.string().max(200).nullish(),
  shipping_cents: z.number().int().min(0).optional(),
  tax_cents: z.number().int().min(0).optional(),
  other_fees_cents: z.number().int().min(0).optional(),
  lines: z.array(draftLineInputSchema).max(500).optional(),
});

export const submitSchema = z.object({});

export const receiveLineSchema = z.object({
  fo_line_id: z.string().min(1),
  qty_received_now: z.number().int().positive().max(1_000_000),
  unit_cost_cents_override: z
    .number()
    .int()
    .min(0)
    .max(1_000_000_000)
    .nullish(),
});

// No vendor_bill_number / vendor_bill_date / qb_memo — FO is Medusa-only
export const receiveSchema = z.object({
  received_at: z.string().datetime().optional(),
  notes: z.string().max(2000).nullish(),
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

export const voidSchema = z.object({
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

export const updateReceiptSchema = z.object({
  line_qty_changes: z
    .array(updateReceiptLineQtySchema)
    .min(1, "at least one line_qty_changes entry required"),
});

export const listQuerySchema = z.object({
  status: z.string().optional(),
  vendor_id: z.string().optional(),
  created_by_user_id: z.string().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  q: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export type DraftLineInput = z.infer<typeof draftLineInputSchema>;
export type CreateDraftInput = z.infer<typeof createDraftSchema>;
export type UpdateDraftInput = z.infer<typeof updateDraftSchema>;
export type ReceiveInput = z.infer<typeof receiveSchema>;
export type ReceiveLineInput = z.infer<typeof receiveLineSchema>;
export type CloseInput = z.infer<typeof closeSchema>;
export type VoidInput = z.infer<typeof voidSchema>;
export type DeleteReceiptInput = z.infer<typeof deleteReceiptSchema>;
export type UpdateReceiptInput = z.infer<typeof updateReceiptSchema>;
export type UpdateReceiptLineQty = z.infer<typeof updateReceiptLineQtySchema>;
export type ListQuery = z.infer<typeof listQuerySchema>;

export const ALLOWED_STATUS_VALUES = FACTORY_ORDER_STATUSES;
