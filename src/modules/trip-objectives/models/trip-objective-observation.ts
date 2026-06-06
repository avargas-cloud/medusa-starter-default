import { model } from "@medusajs/utils";

/**
 * A dated note logged against an objective. `occurred_at` is when it happened
 * (user picks date+time); the frontend groups by trip-local day (Asia/Shanghai)
 * so "per day" is correct while abroad. `parties` is a JSON array of
 * { name, type?, vendor_id? } — who was involved.
 */
export const TripObjectiveObservation = model.define(
  "trip_objective_observation",
  {
    id: model.id({ prefix: "tobs" }).primaryKey(),

    objective_id: model.text(),

    occurred_at: model.dateTime(),
    note: model.text(),

    // [{ name, type?: 'vendor'|'factory'|'staff'|'other', vendor_id? }]
    parties: model.json().nullable(),

    created_by_user_id: model.text().nullable(),
  }
);
