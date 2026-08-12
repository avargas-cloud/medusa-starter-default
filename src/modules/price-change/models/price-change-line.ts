/**
 * src/modules/price-change/models/price-change-line.ts
 * One variant per line inside a price-change batch.
 *
 * Snapshot rule: `old_*` are frozen from the DB at submit time — never trusted
 * from the client. `new_*` is NULL when that field doesn't actually change
 * (submit drops no-op fields per-field, not per-row) — approve treats a NULL
 * `new_*` as "leave this one alone".
 *
 * Money fields use `model.bigNumber()` (numeric + raw_<field> jsonb), the
 * pattern `invoices/` uses for its own dollar snapshots
 * (`pos_invoice_item.unit_price`, `.average_unit_cost`) — see the batch model
 * docstring for why these are dollars, not the cents `pos_invoice` itself uses.
 *
 * `batch` is a REAL ORM relation (belongsTo, like `pos_invoice_item.invoice`)
 * and NOT the plain-text FK that inventory_count/purchase_order lines use:
 * batch + lines are created inside ONE transaction (the gapless
 * display-number claim demands it), and MikroORM can only resolve the FK to a
 * not-yet-committed batch through a declared relation — with a plain text
 * column the in-tx line create dies with "You tried to set relationship
 * batch_id … but such entity does not exist" (bit us on 2026-08-11; the
 * invoices module is the proven in-tx header+lines pattern).
 */
import { model } from "@medusajs/utils";

import PriceChangeBatch from "./price-change-batch";

const PriceChangeLine = model.define("price_change_line", {
  id: model.id({ prefix: "pcl" }).primaryKey(),

  batch: model.belongsTo(() => PriceChangeBatch, { mappedBy: "lines" }),

  variant_id: model.text(),
  product_id: model.text(),
  sku: model.text().nullable(),
  description: model.text().nullable(), // snapshot for display (product title)

  old_cost: model.bigNumber().nullable(),
  new_cost: model.bigNumber().nullable(),
  old_retail: model.bigNumber().nullable(),
  new_retail: model.bigNumber().nullable(),
  old_wholesale: model.bigNumber().nullable(),
  new_wholesale: model.bigNumber().nullable(),
});

export default PriceChangeLine;
