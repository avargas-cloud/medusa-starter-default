import { model } from "@medusajs/utils";

/**
 * An objective TYPE (Sourcing / Negotiation / Decisions, …). Categories are
 * data-driven so the sidebar renders one entry per active category and the
 * field set + status pipeline differ per type.
 *
 * `field_schema`  → FieldDef[]   (see ../types) — drives the per-type form +
 *                                 the visual field builder.
 * `status_set`    → StatusDef[]  — the per-type status dropdown options.
 *
 * NOTE: categories are global (not trip-scoped) so the schema you build is
 * reused across trips. trip_id is nullable for that reason.
 */
export const TripObjectiveCategory = model.define("trip_objective_category", {
  id: model.id({ prefix: "tobjcat" }).primaryKey(),

  trip_id: model.text().nullable(),

  slug: model.text(),
  label: model.text(),

  // Whitelisted Lucide icon key + color token resolved by the frontend.
  icon_key: model.text().default("target"),
  color_token: model.text().default("slate"),

  field_schema: model.json().nullable(),
  status_set: model.json().nullable(),
  default_status_key: model.text().nullable(),

  position: model.number().default(0),
  is_active: model.boolean().default(true),
});
