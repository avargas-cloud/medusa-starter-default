import { model } from "@medusajs/utils";

/**
 * Key/value store for all purchasing algorithm parameters.
 * Editable from the Purchasing Settings UI without a code deploy.
 *
 * Keys defined at seed time — see Migration20260424000000 for the full list.
 */
export const PurchasingConfig = model.define("purchasing_config", {
  key: model.text().primaryKey(),
  value: model.text(),
  label: model.text().nullable(),
});
