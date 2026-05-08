/**
 * src/modules/document-templates/models/pos-document-template.ts
 * Document template entity for Estimates, Orders, and Invoices.
 */

import { model } from "@medusajs/utils";

const PosDocumentTemplate = model.define("pos_document_template", {
  id: model.id().primaryKey(),
  name: model.text(), // "Invoice Ecopowertech"
  doc_type: model.enum([
    "estimate",
    "order",
    "invoice",
    "purchase_order",
    "purchase_order_receipt",
    "factory_order",
    "return",
    "statement",
    "payment",
  ]),
  is_default: model.boolean().default(false),
  thumbnail: model.text().nullable(), // base64 or Minio URL
  field_config: model.json().default({}), // FieldConfig object
  layout_data: model.json().nullable(), // LayoutElement[] (null = empty)
  layout_guides: model.json().nullable(), // Guide lines (null = empty)
  created_by: model.text().nullable(),
});

export default PosDocumentTemplate;
