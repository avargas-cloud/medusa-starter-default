/**
 * Canonical `vendors` MeiliSearch document mapping.
 *
 * This lives in a plain `.ts` module ON PURPOSE. It used to live in
 * `src/lib/meili-backend.mts` and every consumer reached it through a dynamic
 * `await import("../lib/meili-backend.mts")`. That resolves in dev and in the
 * sandbox — where the `.mts` source file is on disk — but `medusa build` emits
 * it as `meili-backend.mjs`, so in production every one of those imports threw:
 *
 *   Cannot find module '/app/src/lib/meili-backend.mts'
 *
 * The vendor sync steps swallow their own errors, so the failure was silent:
 * the ONE route that did sync vendors to Meili had been a no-op in production,
 * and vendors accumulated in Postgres while staying unsearchable. Keep the
 * imports below static — a dynamic import of a `.mts` path is the bug.
 *
 * Searchable surface: full_name, name, company_name, email, phone, qb_list_id,
 * account_number, contact, city. Consumed by `searchVendors` (Factory Order
 * manufacturer picker, PO vendor picker).
 */

export const VENDORS_INDEX = "vendors";

/** A `qb_vendor` row, as returned by the module service or query.graph. */
export interface VendorSource {
  id: string;
  qb_list_id?: string | null;
  full_name?: string | null;
  name?: string | null;
  company_name?: string | null;
  account_number?: string | null;
  is_active?: boolean | null;
  first_name?: string | null;
  last_name?: string | null;
  contact?: string | null;
  email?: string | null;
  phone?: string | null;
  alt_phone?: string | null;
  fax?: string | null;
  addr1?: string | null;
  addr2?: string | null;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
  country?: string | null;
  terms_ref_name?: string | null;
  vendor_type_ref_name?: string | null;
  currency_ref_name?: string | null;
  tax_identity?: string | null;
  is_vendor_eligible_for_1099?: boolean | null;
  credit_limit?: number | null;
  sync_status?: string | null;
  metadata?: Record<string, unknown> | null;
  updated_at?: Date | string | null;
  created_at?: Date | string | null;
  [key: string]: unknown;
}

export function transformVendor(
  vendor: VendorSource
): Record<string, unknown> {
  return {
    id: vendor.id,
    qb_list_id: vendor.qb_list_id ?? null,
    full_name: vendor.full_name ?? null,
    name: vendor.name ?? null,
    company_name: vendor.company_name ?? null,
    account_number: vendor.account_number ?? null,
    is_active: vendor.is_active ?? true,

    first_name: vendor.first_name ?? null,
    last_name: vendor.last_name ?? null,
    contact: vendor.contact ?? null,

    email: vendor.email ?? null,
    phone: vendor.phone ?? null,
    alt_phone: vendor.alt_phone ?? null,
    fax: vendor.fax ?? null,

    addr1: vendor.addr1 ?? null,
    addr2: vendor.addr2 ?? null,
    city: vendor.city ?? null,
    state: vendor.state ?? null,
    postal_code: vendor.postal_code ?? null,
    country: vendor.country ?? null,

    terms_ref_name: vendor.terms_ref_name ?? null,
    payment_terms:
      (vendor.metadata?.payment_terms as string | undefined) ?? null,
    vendor_type_ref_name: vendor.vendor_type_ref_name ?? null,
    currency_ref_name: vendor.currency_ref_name ?? null,

    tax_identity: vendor.tax_identity ?? null,
    is_vendor_eligible_for_1099: vendor.is_vendor_eligible_for_1099 ?? null,
    credit_limit: vendor.credit_limit ?? null,

    sync_status: vendor.sync_status ?? null,

    updated_at: vendor.updated_at
      ? new Date(vendor.updated_at).getTime()
      : Date.now(),
    created_at: vendor.created_at
      ? new Date(vendor.created_at).getTime()
      : Date.now(),
  };
}
