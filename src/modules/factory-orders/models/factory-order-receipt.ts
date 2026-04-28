import { model } from "@medusajs/utils";

/**
 * A physical receipt event against a factory order.
 *
 * Lifecycle (simplified — no QB sync step):
 *   pending  → stock apply in progress (transient)
 *   applied  → Medusa inventory updated
 *   voided   → receipt reversed; stock contra-applied
 *   error    → stock apply failed; admin resolves manually
 *
 * Numbering: FRCP-{seq} from `custom_fo_receipt_seq`.
 * stock_location_id is always China Warehouse.
 */
export const FactoryOrderReceipt = model.define("factory_order_receipt", {
  id: model.id({ prefix: "fore" }).primaryKey(),

  factory_order_id: model.text(),

  number: model.text(),
  seq: model.number(),

  status: model.text().default("pending"),

  received_at: model.dateTime(),
  received_by_user_id: model.text(),
  stock_location_id: model.text(),

  notes: model.text().nullable(),

  voided_at: model.dateTime().nullable(),
  voided_by_user_id: model.text().nullable(),
  void_reason: model.text().nullable(),
});
