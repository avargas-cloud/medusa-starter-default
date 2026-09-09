import { model } from "@medusajs/utils";

export const BankDayClose = model.define("bank_day_close", {
  id: model.id({ prefix: "bday" }).primaryKey(),
  day: model.text(),
  revision: model.number().default(1),
  status: model.enum(["open", "closed"]).default("open"),
  snapshot: model.json().nullable(),
  input_hash: model.text().nullable(),
  closed_by: model.text().nullable(),
  closed_at: model.dateTime().nullable(),
  reopened_by: model.text().nullable(),
  reopened_at: model.dateTime().nullable(),
  reopen_reason: model.text().nullable(),
  needs_review: model.boolean().default(false),
  // SQL supplies [] and checks the array shape; DML JSON defaults accept only objects.
  history: model.json(),
});
