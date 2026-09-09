import { model } from "@medusajs/utils";

import { BankTransaction } from "./bank-transaction";

/** Private immutable bytes. Replacing or detaching hard-deletes the row (operator
 * decision 2026-09-09: one PDF per movement, no history of superseded files).
 * `detached_at` is kept for schema compatibility but is no longer written. */
export const BankReviewAttachment = model.define("bank_review_attachment", {
  id: model.id({ prefix: "batt" }).primaryKey(),
  transaction: model.belongsTo(() => BankTransaction, {
    mappedBy: "review_attachments",
  }),
  original_name: model.text(),
  mime_type: model.enum(["image/png", "image/jpeg", "application/pdf"]),
  size_bytes: model.number(),
  sha256: model.text(),
  content_base64: model.text(),
  uploaded_by: model.text(),
  detached_at: model.dateTime().nullable(),
});
