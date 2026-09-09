import { model } from "@medusajs/utils";

import { BankAccount } from "./bank-account";
import { BankSyncRun } from "./bank-sync-run";
import { BankTransaction } from "./bank-transaction";
import { BankWebhookEvent } from "./bank-webhook-event";

/** Provider access and ingestion state. Never return the encrypted token in API DTOs. */
export const BankConnection = model.define("bank_connection", {
  id: model.id({ prefix: "bconn" }).primaryKey(),
  provider: model.text(),
  environment: model.enum(["sandbox", "production"]),
  provider_item_id: model.text(),
  // Serialized versioned encryption envelope with key ID; NULL after revocation.
  access_token_encrypted: model.text().nullable(),
  institution_id: model.text().nullable(),
  institution_name: model.text().nullable(),
  status: model
    .enum([
      "awaiting_selection",
      "active",
      "reauth_required",
      "disconnected",
      "error",
    ])
    .default("awaiting_selection"),
  // Only advance after all pages and their revisions have committed.
  cursor: model.text().nullable(),
  initial_sync_complete: model.boolean().default(false),
  historical_sync_complete: model.boolean().default(false),
  consent_expiration_time: model.dateTime().nullable(),
  pending_disconnect: model.boolean().default(false),
  sync_requested_at: model.dateTime().nullable(),
  last_successful_sync_at: model.dateTime().nullable(),
  last_error_code: model.text().nullable(),
  // Application-sanitized text only; never persist a raw provider error.
  last_error_message: model.text().nullable(),
  refresh_requested_at: model.dateTime().nullable(),
  refresh_completed_at: model.dateTime().nullable(),
  created_by: model.text().nullable(),
  linked_public_token_hash: model.text().nullable(),
  metadata: model.json().nullable(),
  accounts: model.hasMany(() => BankAccount, { mappedBy: "connection" }),
  transactions: model.hasMany(() => BankTransaction, {
    mappedBy: "connection",
  }),
  sync_runs: model.hasMany(() => BankSyncRun, { mappedBy: "connection" }),
  webhook_events: model.hasMany(() => BankWebhookEvent, {
    mappedBy: "connection",
  }),
});
