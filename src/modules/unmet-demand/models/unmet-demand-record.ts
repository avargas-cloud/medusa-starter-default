import { model } from "@medusajs/utils";

/**
 * Header for an unmet-demand event.
 *
 * Totals are SNAPSHOTTED by the create/update workflow — never trust the
 * client. unmet_value_cents is refreshed at the same time so analytics
 * queries can sort/filter without joining items.
 *
 * customer_id is NOT NULL: walk-ins are represented by the generic
 * "Any Contractor" / "Any Customer FL" customers that already exist.
 *
 * price_tier defaults from the customer's qb_price_level at creation but
 * can be overridden manually per record.
 */
export const UnmetDemandRecord = model.define("unmet_demand_record", {
  id: model.id({ prefix: "umdrec" }).primaryKey(),

  // Friendly numbering — UMD-{seq} e.g. UMD-1001
  // Allocated at creation from the shared custom_unmet_demand_seq Postgres
  // sequence. Nullable to stay compatible with rows created before the
  // numbering migration (20260420200000).
  number: model.text().nullable(),
  seq: model.number().nullable(),
  year: model.number().nullable(),

  customer_id: model.text(),
  created_by_user_id: model.text(),

  // 'retail' | 'wholesale' — default price lookup for rows at this record
  price_tier: model.text().default("retail"),

  // Denormalized totals — refreshed by the workflow at every write
  requested_total_cents: model.number().default(0),
  purchased_total_cents: model.number().default(0),
  unmet_value_cents: model.number().default(0),

  // Free-text staff note
  notes: model.text().nullable(),
});
