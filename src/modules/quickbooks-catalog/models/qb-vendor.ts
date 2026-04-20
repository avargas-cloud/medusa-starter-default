import { model } from "@medusajs/utils";

/**
 * QuickBooks Vendors cached locally.
 * Synced manually from the bridge via GET /api/vendors.
 * Used to populate Preferred Vendor dropdown in the POS item creation modal.
 */
export const QbVendor = model.define("qb_vendor", {
  id: model.id({ prefix: "qbvnd" }).primaryKey(),
  qb_list_id: model.text(),
  full_name: model.text(),
  name: model.text(),
  company_name: model.text().nullable(),
  account_number: model.text().nullable(),
  is_active: model.boolean().default(true),

  first_name: model.text().nullable(),
  middle_initial: model.text().nullable(),
  last_name: model.text().nullable(),
  contact: model.text().nullable(),
  alt_contact: model.text().nullable(),

  email: model.text().nullable(),
  phone: model.text().nullable(),
  alt_phone: model.text().nullable(),
  fax: model.text().nullable(),

  addr1: model.text().nullable(),
  addr2: model.text().nullable(),
  city: model.text().nullable(),
  state: model.text().nullable(),
  postal_code: model.text().nullable(),
  country: model.text().nullable(),

  terms_ref_name: model.text().nullable(),
  prefill_account_ref_name: model.text().nullable(),
  vendor_type_ref_name: model.text().nullable(),
  currency_ref_name: model.text().nullable(),

  tax_identity: model.text().nullable(),
  is_vendor_eligible_for_1099: model.boolean().nullable(),
  credit_limit: model.number().nullable(),

  notes: model.text().nullable(),

  sync_status: model.text().nullable(), // waiting | synced | error | failed_permanent
  qb_operation_id: model.text().nullable(),
  last_error: model.text().nullable(),
  resolved_at: model.dateTime().nullable(),
  retry_count: model.number().default(0),
  next_retry_at: model.dateTime().nullable(),

  last_synced_at: model.dateTime().default(new Date()),
  metadata: model.json().nullable(),
});
