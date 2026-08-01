/**
 * Vendor payment terms — the canonical double field.
 *
 * ONE option carries BOTH halves of what a payment term actually is: the name
 * QuickBooks knows it by, and the rule that turns a bill date into a due date.
 * Before this module those halves lived in three places that could disagree
 * (`qb_vendor.terms_ref_name`, `metadata.payment_terms`,
 * `metadata.default_payment_terms_days`) and in production they DID: a vendor
 * named "30 days" resolved to 0, one named "Due on receipt" resolved to 30.
 *
 * Two kinds of rule, mirroring the two QuickBooks terms tables:
 *
 *   standard    — due N days after the bill date        (StandardTermsRet.StdDueDays)
 *   date_driven — due on day D of the month             (DateDrivenTermsRet.DayOfMonthDue)
 *
 * A term is exactly one kind. `days` and `day_of_month_due` are never both set
 * and never both null on a valid option — see `isValidTerm`.
 */

/** Where a term option lives in `system_defaults`. */
export const VENDOR_TERMS_CONTEXT = "Vendor Defaults";

/**
 * Deliberately NOT "Payment Terms". `/admin/estimate-options` matches option
 * rows by `field_name` ALONE (it does not filter by context), so reusing that
 * name would leak vendor terms into the customer/estimate dropdown.
 */
export const VENDOR_TERMS_FIELD = "Vendor Payment Terms";

export const VENDOR_TERMS_SCOPE = "vendors";

export type VendorTermKind = "standard" | "date_driven";

/** The `metadata` JSONB payload of a `system_defaults` term row. */
export interface VendorTermMetadata {
  /** Days from bill date to due date. Set iff kind is "standard". */
  days: number | null;
  /** Day of month the bill comes due. Set iff kind is "date_driven". */
  day_of_month_due: number | null;
  /**
   * QuickBooks rolls the due date to the FOLLOWING month when the bill lands
   * within this many days of the due day. Date-driven terms only; 0 disables.
   */
  due_next_month_days: number | null;
  /**
   * Does a term with this exact name exist in the QuickBooks Terms list?
   * A `VendorMod` carrying a TermsRef that QB does not know is rejected, so
   * this gates whether the option is safe to push.
   */
  exists_in_qb: boolean;
  /** ISO timestamp of the last reconciliation against the QB Terms list. */
  qb_synced_at: string | null;
  /**
   * Is the term still ACTIVE in the QuickBooks Terms list?
   *
   * Measured 2026-08-01: QB has 31 terms, only 15 active — and 8 of the
   * inactive ones are still assigned to 37 live vendors (Net-10 alone has 25).
   * So an inactive term can be neither hidden nor offered: hiding it would
   * leave those vendors with no readable term, and offering it invites new
   * assignments to something the accountant retired.
   */
  is_active: boolean;
}

/** A term option as the rest of the codebase consumes it. */
export interface VendorTermOption extends VendorTermMetadata {
  /** `system_defaults.id` — stable across renames. */
  id: string;
  /** The name QuickBooks knows this term by. Case preserved exactly. */
  name: string;
  sort_order: number;
}

export const isDateDriven = (t: {
  day_of_month_due: number | null;
}): boolean => t.day_of_month_due != null;

export const termKind = (t: {
  day_of_month_due: number | null;
}): VendorTermKind => (isDateDriven(t) ? "date_driven" : "standard");

export const MAX_TERMS_DAYS = 365;

/**
 * A term must express exactly one rule. Both-null is the shape that produced
 * the silent zeros this module exists to kill: a term with no rule at all reads
 * as "due immediately" everywhere it is consumed.
 */
export function isValidTerm(m: {
  days: number | null;
  day_of_month_due: number | null;
}): boolean {
  const hasDays =
    m.days != null &&
    Number.isInteger(m.days) &&
    m.days >= 0 &&
    m.days <= MAX_TERMS_DAYS;
  const hasDom =
    m.day_of_month_due != null &&
    Number.isInteger(m.day_of_month_due) &&
    m.day_of_month_due >= 1 &&
    m.day_of_month_due <= 31;
  // Exactly one, never both, never neither.
  return hasDays !== hasDom;
}

/**
 * Case/whitespace-insensitive key for matching a stored name against the QB
 * Terms list. Punctuation is PRESERVED on purpose: "Net 30" and "Net-30" are
 * two distinct live terms in the company file (both 30 days, both assigned to
 * real vendors), so collapsing the dash would merge two things QuickBooks
 * considers different. Mirrors `normalizeTermsKey` in lib/quickbooks/qb-terms.
 */
export function normalizeVendorTermKey(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}
