import { model } from "@medusajs/utils";

import { BankConnection } from "./bank-connection";

/** Verified webhook inbox. A repeated delivery reuses its durable digest identity. */
export const BankWebhookEvent = model.define("bank_webhook_event", {
  id: model.id({ prefix: "bwevt" }).primaryKey(),
  provider: model.text(),
  environment: model.enum(["sandbox", "production"]),
  connection: model
    .belongsTo(() => BankConnection, { mappedBy: "webhook_events" })
    .nullable(),
  event_digest: model.text(),
  event_type: model.text(),
  payload: model.json(),
  status: model
    .enum(["pending", "processing", "processed", "failed"])
    .default("pending"),
  attempts: model.number().default(0),
  received_at: model.dateTime(),
  processed_at: model.dateTime().nullable(),
  last_error_code: model.text().nullable(),
  // Application-sanitized text only.
  last_error_message: model.text().nullable(),
});
