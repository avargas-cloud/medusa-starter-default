import { model } from "@medusajs/utils";

import { BankConnection } from "./bank-connection";

export const BankSyncRun = model.define("bank_sync_run", {
  id: model.id({ prefix: "bsync" }).primaryKey(),
  connection: model.belongsTo(() => BankConnection, { mappedBy: "sync_runs" }),
  trigger: model.enum(["initial", "webhook", "scheduled", "manual"]),
  status: model.enum(["running", "succeeded", "failed"]).default("running"),
  started_at: model.dateTime(),
  finished_at: model.dateTime().nullable(),
  error_code: model.text().nullable(),
  // Application-sanitized text only.
  error_message: model.text().nullable(),
  cursor_before: model.text().nullable(),
  cursor_after: model.text().nullable(),
  added_count: model.number().default(0),
  modified_count: model.number().default(0),
  removed_count: model.number().default(0),
});
