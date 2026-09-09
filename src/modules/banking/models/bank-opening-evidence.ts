import { model } from "@medusajs/utils";
export const BankOpeningEvidence = model.define("bank_opening_evidence", {
  id: model.id({ prefix: "boe" }).primaryKey(),
  original_name: model.text(),
  mime_type: model.text(),
  size_bytes: model.number(),
  sha256: model.text(),
  content_base64: model.text(),
  uploaded_by: model.text()
});
