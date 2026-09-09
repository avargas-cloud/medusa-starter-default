import { model } from "@medusajs/utils";
export const BankEvidenceDocument = model.define("bank_evidence_document", {
  id: model.id({ prefix: "bed" }).primaryKey(),
  original_name: model.text(),
  mime_type: model.text(),
  size_bytes: model.number(),
  sha256: model.text(),
  version: model.number(),
  content_base64: model.text(),
  uploaded_by: model.text(),
});
