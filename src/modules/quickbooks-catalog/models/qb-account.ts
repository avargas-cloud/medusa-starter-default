import { model } from "@medusajs/utils";

/**
 * QuickBooks Chart of Accounts cached locally.
 * Synced manually from the bridge via GET /api/accounts.
 * Used to populate COGS / Income / Expense dropdowns in the POS item creation modal.
 */
export const QbAccount = model.define("qb_account", {
  id: model.id({ prefix: "qbacc" }).primaryKey(),
  qb_list_id: model.text(), // ListID from QB (unique)
  full_name: model.text(), // e.g. "Sales:Ecopowertech:LED Strips"
  name: model.text(), // leaf name, e.g. "LED Strips"
  account_type: model.text(), // "Income" | "CostOfGoodsSold" | "Expense" | "Bank" | ...
  parent_full_name: model.text().nullable(),
  currency: model.text().nullable(),
  is_active: model.boolean().default(true),
  last_synced_at: model.dateTime().default(new Date()),
  metadata: model.json().nullable(),
});
