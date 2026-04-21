/**
 * src/api/admin/unmet-demand/_lib/validators.ts
 *
 * Zod schemas for unmet-demand request bodies and filters.
 */

import { z } from "zod";

import {
  PRICE_TIERS,
  UNMET_DEMAND_ITEM_KINDS,
} from "../../../../modules/unmet-demand/types";

export const itemInputSchema = z.object({
  kind: z.enum(UNMET_DEMAND_ITEM_KINDS),
  product_id: z.string().min(1).nullish(),
  variant_id: z.string().min(1).nullish(),
  sku: z.string().min(1, "sku is required"),
  title: z.string().min(1, "title is required"),
  thumbnail: z.string().max(2000).nullish(),
  sales_description: z.string().max(5000).nullish(),
  quantity: z.number().int().positive().max(100000),
  unit_price_cents: z.number().int().min(0).max(100000000),
});

export const createRecordSchema = z.object({
  customer_id: z.string().min(1, "customer_id is required"),
  price_tier: z.enum(PRICE_TIERS).default("retail"),
  notes: z.string().max(2000).nullish(),
  items: z.array(itemInputSchema).max(500).default([]),
});

export const updateRecordSchema = z.object({
  customer_id: z.string().min(1).optional(),
  price_tier: z.enum(PRICE_TIERS).optional(),
  notes: z.string().max(2000).nullish(),
  items: z.array(itemInputSchema).max(500).optional(),
});

export const listQuerySchema = z.object({
  customer_id: z.string().min(1).optional(),
  created_by_user_id: z.string().min(1).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  min_unmet_value_cents: z.coerce.number().int().min(0).optional(),
  max_unmet_value_cents: z.coerce.number().int().min(0).optional(),
  sku: z.string().min(1).optional(),
  kind: z.enum(UNMET_DEMAND_ITEM_KINDS).optional(),
  group: z.enum(["customer", "item"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export type ItemInput = z.infer<typeof itemInputSchema>;
export type CreateRecordInput = z.infer<typeof createRecordSchema>;
export type UpdateRecordInput = z.infer<typeof updateRecordSchema>;
export type ListQuery = z.infer<typeof listQuerySchema>;
