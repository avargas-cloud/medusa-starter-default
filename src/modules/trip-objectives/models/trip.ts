import { model } from "@medusajs/utils";

import { DEFAULT_TRIP_TIMEZONE } from "../types";

/**
 * A planned buying trip (e.g. China). Objectives + categories hang off a trip
 * so a second trip never collides with the first. One trip is `is_active` at a
 * time; the POS scopes everything to the active trip by default.
 */
export const Trip = model.define("trip", {
  id: model.id({ prefix: "trip" }).primaryKey(),

  name: model.text(),
  destination: model.text().nullable(),

  starts_at: model.dateTime().nullable(),
  ends_at: model.dateTime().nullable(),

  // Observations group by trip-local day — Asia/Shanghai by default.
  timezone: model.text().default(DEFAULT_TRIP_TIMEZONE),

  // planned | active | completed | archived
  status: model.text().default("planned"),
  is_active: model.boolean().default(false),

  created_by_user_id: model.text().nullable(),
});
