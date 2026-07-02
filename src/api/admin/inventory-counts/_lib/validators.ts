/**
 * src/api/admin/inventory-counts/_lib/validators.ts
 *
 * Zod schemas validate request bodies at the route boundary. The compiled
 * types feed the route handlers, so any shape change here propagates as
 * compile errors.
 */

import { z } from "zod";

import { APPROVAL_LINE_ACTIONS } from "../../../../modules/inventory-count/types";

export const createDraftSchema = z.object({
  stock_location_id: z.string().min(1, "stock_location_id is required"),
  category_filter_id: z.string().nullish(),
  sku_prefix_filter: z.string().nullish(),
  default_qb_account_list_id: z.string().min(1).optional(),
});

export const updateDraftLineSchema = z.object({
  product_variant_id: z.string().min(1),
  inventory_item_id: z.string().min(1),
  sku: z.string().min(1),
  product_title: z.string().min(1),
  // Split capture: on_hand (floor) + reserved (apartados). qty_counted (total)
  // is derived server-side. on_hand null = uncounted.
  qty_counted_available: z.number().int().min(0).nullable(),
  qty_counted_reserved: z.number().int().min(0).nullable(),
  qb_account_list_id: z.string().min(1).nullish(),
});

export const updateDraftSchema = z.object({
  lines: z.array(updateDraftLineSchema).max(2000).optional(),
  memo: z.string().trim().max(500).optional(),
});

export const submitSchema = z.object({
  memo: z.string().trim().min(5, "memo must be at least 5 characters").max(500),
});

export const approvalDecisionSchema = z
  .object({
    line_id: z.string().min(1),
    action: z.enum(APPROVAL_LINE_ACTIONS),
    override_delta: z.number().int().optional(),
    override_note: z.string().max(500).optional(),
    qb_account_list_id: z.string().min(1).optional(),
  })
  .superRefine((d, ctx) => {
    if (d.action === "override" && d.override_delta === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["override_delta"],
        message: "override_delta is required when action='override'",
      });
    }
    // A skip must always be justified. An override (manager recount/correction)
    // may carry a note for the audit trail but does not require one — the manager
    // is the final authority and corrections are common on otherwise-good lines.
    if (d.action === "skip" && (!d.override_note || !d.override_note.trim())) {
      ctx.addIssue({
        code: "custom",
        path: ["override_note"],
        message: "override_note is required for skip actions",
      });
    }
  });

export const approveSchema = z.object({
  decisions: z.array(approvalDecisionSchema).max(2000),
});

export const rejectSchema = z.object({
  review_notes: z
    .string()
    .trim()
    .min(10, "review_notes must be at least 10 characters")
    .max(1000),
});

export const voidSchema = z.object({
  void_reason: z
    .string()
    .trim()
    .min(10, "void_reason must be at least 10 characters")
    .max(1000),
});

export const listQuerySchema = z.object({
  status: z.string().optional(),
  stock_location_id: z.string().optional(),
  created_by_user_id: z.string().optional(),
  reviewed_by_user_id: z.string().optional(),
  q: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
