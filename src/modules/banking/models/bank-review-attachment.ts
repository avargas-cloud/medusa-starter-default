import { model } from "@medusajs/utils";
import { BankTransaction } from "./bank-transaction";

/** Private immutable bytes. Detach hides the current association without erasing history. */
export const BankReviewAttachment = model.define("bank_review_attachment", {
  id: model.id({ prefix: "batt" }).primaryKey(),
  transaction: model.belongsTo(() => BankTransaction, { mappedBy: "review_attachments" }),
  original_name: model.text(),
  mime_type: model.enum(["image/png", "image/jpeg", "application/pdf"]),
  size_bytes: model.number(),
  sha256: model.text(),
  content_base64: model.text(),
  uploaded_by: model.text(),
  detached_at: model.dateTime().nullable(),
});
