import { model } from "@medusajs/utils";
import { BankTransaction } from "./bank-transaction";

/** Append-only audit/receipt. Details and result contain references, never attachment bytes. */
export const BankReviewEvent = model.define("bank_review_event", {
  id: model.id({ prefix: "brevt" }).primaryKey(),
  entity_type: model.text(),
  entity_id: model.text(),
  transaction: model.belongsTo(() => BankTransaction, { mappedBy: "review_events" }).nullable(),
  action: model.text(),
  actor_id: model.text(),
  details: model.json(),
  idempotency_key: model.text().nullable(),
  request_hash: model.text().nullable(),
  result: model.json().nullable(),
});
