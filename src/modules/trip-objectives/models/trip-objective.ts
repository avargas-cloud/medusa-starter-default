import { model } from "@medusajs/utils";

/**
 * One objective. Common fields are real columns; the per-type structured data
 * (target price, MOQ, lumens, watts, …) lives in `fields` JSONB validated
 * against the category's field_schema. `active_optional_fields` records which
 * optional/addable spec fields the user turned on for THIS entry, so an empty
 * spec still renders once added.
 */
export const TripObjective = model.define("trip_objective", {
  id: model.id({ prefix: "tobj" }).primaryKey(),

  trip_id: model.text(),
  category_id: model.text(),

  // Optional sub-group within the category (id from category.groups).
  group_id: model.text().nullable(),

  title: model.text(),
  description: model.text().nullable(),

  status_key: model.text().nullable(),
  // low | normal | high | urgent
  priority: model.text().default("normal"),

  // Reference image (client-resized): store BOTH the public URL and the MinIO
  // key so we can move to signed URLs later without a data migration.
  reference_image_url: model.text().nullable(),
  reference_image_key: model.text().nullable(),
  reference_image_thumb_url: model.text().nullable(),
  reference_image_thumb_key: model.text().nullable(),

  // Optional link to an existing catalog product (resolved via MeiliSearch).
  product_variant_id: model.text().nullable(),
  product_sku: model.text().nullable(),
  product_title: model.text().nullable(),
  product_thumbnail_url: model.text().nullable(),

  // Per-type structured values (objective-scope fields), keyed by FieldDef.key.
  fields: model.json().nullable(),
  // Keys of optional spec fields enabled on this entry.
  active_optional_fields: model.json().nullable(),

  // Sourcing results: array of ObjectiveQuote (see ../types). A product being
  // sourced can have several quotes — even multiple from the same supplier.
  quotes: model.json().nullable(),

  metadata: model.json().nullable(),

  position: model.number().default(0),

  created_by_user_id: model.text().nullable(),
  updated_by_user_id: model.text().nullable(),
});
