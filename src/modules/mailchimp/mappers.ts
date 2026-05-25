import type {
  MailchimpAddress,
  MailchimpMergeFields,
  MailchimpUpsertPayload,
} from "./types";

/**
 * Cutoff: customers created from this instant onward are considered "born in the POS"
 * and synced as Customer Status = "New Customer". Earlier customers are legacy
 * (mostly imported from QuickBooks) and synced as "Active".
 *
 * Anchored to America/New_York midnight on 2026-04-14 → UTC 04:00 (during EDT).
 */
export const NEW_CUSTOMER_CUTOFF_UTC = new Date("2026-04-14T04:00:00.000Z");

export interface CustomerForMailchimp {
  id: string;
  email: string;
  first_name?: string | null;
  last_name?: string | null;
  phone?: string | null;
  company_name?: string | null;
  created_at: Date;
  metadata?: Record<string, unknown> | null;
  defaultAddress?: {
    address_1?: string | null;
    address_2?: string | null;
    city?: string | null;
    province?: string | null;
    postal_code?: string | null;
    country_code?: string | null;
    phone?: string | null;
  } | null;
}

/**
 * The Mailchimp `Customer Status` (MMERGE7) text value applied at sync time.
 * One-time decision per customer; we never re-classify on subsequent syncs.
 */
export function deriveCustomerStatus(createdAt: Date): string {
  return createdAt >= NEW_CUSTOMER_CUTOFF_UTC ? "New Customer" : "Active";
}

function trimToNonEmpty(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function buildAddress(
  address: CustomerForMailchimp["defaultAddress"]
): MailchimpAddress | undefined {
  if (!address) return undefined;
  const addr1 = trimToNonEmpty(address.address_1);
  const city = trimToNonEmpty(address.city);
  const state = trimToNonEmpty(address.province);
  const zip = trimToNonEmpty(address.postal_code);
  const countryRaw = trimToNonEmpty(address.country_code);

  // Mailchimp's ADDRESS merge field requires addr1 + city + state + zip + country.
  // Missing any one of those → it rejects the whole payload with a vague 400.
  if (!addr1 || !city || !state || !zip || !countryRaw) return undefined;

  return {
    addr1,
    addr2: trimToNonEmpty(address.address_2),
    city,
    state,
    zip,
    country: countryRaw.toUpperCase(),
  };
}

/**
 * Tags propagated to Mailchimp. Additive: existing tags are preserved.
 */
export function buildTags(customer: CustomerForMailchimp): string[] {
  const tags: string[] = ["source:pos"];

  const meta = (customer.metadata ?? {}) as Record<string, unknown>;
  const priceLevel = typeof meta.qb_price_level === "string"
    ? meta.qb_price_level.toLowerCase()
    : null;
  if (priceLevel === "wholesale") tags.push("price-level:wholesale");
  else if (priceLevel === "retail") tags.push("price-level:retail");

  return tags;
}

/**
 * Build the full Mailchimp upsert payload from a Medusa customer record.
 * `defaultStatusIfNew` decides whether a brand-new member enters as `transactional`
 * (CRM-only, no marketing opt-in) or `subscribed` (marketing list).
 */
export function customerToMailchimpPayload(
  customer: CustomerForMailchimp,
  defaultStatusIfNew: MailchimpUpsertPayload["statusIfNew"]
): MailchimpUpsertPayload {
  const meta = (customer.metadata ?? {}) as Record<string, unknown>;

  const mergeFields: MailchimpMergeFields = {
    FNAME: trimToNonEmpty(customer.first_name),
    LNAME: trimToNonEmpty(customer.last_name),
    PHONE: trimToNonEmpty(customer.phone) ?? trimToNonEmpty(customer.defaultAddress?.phone),
    MMERGE5: trimToNonEmpty(customer.company_name),
    MMERGE7: deriveCustomerStatus(customer.created_at),
    CUSTYPE: trimToNonEmpty(meta.qb_customer_type),
    ACQCHN: trimToNonEmpty(meta.acquisition_channel),
  };

  const address = buildAddress(customer.defaultAddress);
  if (address) mergeFields.ADDRESS = address;

  // Strip undefined entries — Mailchimp treats `null`/`undefined` literally and
  // would overwrite an existing merge field with an empty value.
  const cleaned = Object.fromEntries(
    Object.entries(mergeFields).filter(([, v]) => v !== undefined)
  ) as MailchimpMergeFields;

  return {
    email: customer.email.trim().toLowerCase(),
    mergeFields: cleaned,
    tags: buildTags(customer),
    statusIfNew: defaultStatusIfNew,
  };
}
