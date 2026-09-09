import { model } from "@medusajs/utils";

import { BankAccount } from "./bank-account";
import { BankConnection } from "./bank-connection";
import { BankTransactionReview } from "./bank-transaction-review";
import { BankReviewEvent } from "./bank-review-event";
import { BankReviewAttachment } from "./bank-review-attachment";

/** Bank evidence only: ingestion does not create a payment or accounting posting. */
export const BankTransaction = model.define("bank_transaction", {
  id: model.id({ prefix: "btxn" }).primaryKey(),
  connection: model.belongsTo(() => BankConnection, { mappedBy: "transactions" }),
  account: model.belongsTo(() => BankAccount, { mappedBy: "transactions" }),
  provider_transaction_id: model.text(),
  pending_transaction_id: model.text().nullable(),
  // Exact decimal in MAJOR currency units with provider sign convention retained.
  // Text avoids JS floats and Medusa BigNumber/raw_* conversion. Never default USD.
  amount: model.text(),
  currency: model.text().nullable(),
  unofficial_currency: model.text().nullable(),
  status: model.enum(["pending", "posted", "removed"]),
  transaction_date: model.text(),
  authorized_date: model.text().nullable(),
  name: model.text(),
  merchant_name: model.text().nullable(),
  source_data: model.json(),
  // Append old source snapshots atomically in SQL on modified/removed events.
  // SQL owns the [] default: Medusa's json().default() type only permits objects.
  source_revisions: model.json(),
  source_version: model.number().default(1),
  first_seen_at: model.dateTime(),
  last_seen_at: model.dateTime(),
  removed_at: model.dateTime().nullable(),
  reviews: model.hasMany(() => BankTransactionReview, { mappedBy: "transaction" }),
  review_events: model.hasMany(() => BankReviewEvent, { mappedBy: "transaction" }),
  review_attachments: model.hasMany(() => BankReviewAttachment, { mappedBy: "transaction" }),
});
