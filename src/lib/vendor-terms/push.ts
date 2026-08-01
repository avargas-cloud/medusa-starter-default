/**
 * Deciding whether a vendor edit has to reach QuickBooks, and reporting how it
 * went.
 *
 * Since 2026-08-01 the POS is where vendors are authored, so a payment term
 * changed here has to be pushed. Two things this module is careful about:
 *
 * 1. It pushes only when something QuickBooks cares about actually MOVED.
 *    A save that re-sends the same term is not a change, and firing a VendorMod
 *    on every save would put a bridge round trip behind every keystroke-level
 *    edit and bury real failures in noise.
 *
 * 2. A failed push is never swallowed. The local write already happened — that
 *    is correct, the POS is the source of truth now — but a vendor whose term
 *    did not reach QuickBooks is DRIFTED, and drift that nothing reports is the
 *    failure mode this codebase keeps rediscovering. The outcome lands on
 *    `qb_vendor.sync_status` + `last_error`, which the vendor page already
 *    renders, rather than in a log nobody reads.
 */

import type { QbVendorSnapshot } from "../quickbooks/qb-vendor-mod";
import { normalizeVendorTermKey } from "./types";

/**
 * Fields whose change means QuickBooks has to be told.
 *
 * Every entry must be a REAL column on `qb_vendor` — this list is what the
 * PATCH route feeds to `query.graph`, so a name that is not a column fails the
 * whole read. `name_on_check` is deliberately absent for that reason: QBXML has
 * the element, we have never stored it, and the Mod simply omits it.
 */
export const QB_RELEVANT_FIELDS = [
  "name",
  "company_name",
  "first_name",
  "middle_initial",
  "last_name",
  "contact",
  "alt_contact",
  "account_number",
  "notes",
  "email",
  "phone",
  "alt_phone",
  "fax",
  "tax_identity",
  "vendor_type_ref_name",
  "terms_ref_name",
  "credit_limit",
  "is_vendor_eligible_for_1099",
  "is_active",
  "addr1",
  "addr2",
  "city",
  "state",
  "postal_code",
  "country",
] as const;

export type QbRelevantField = (typeof QB_RELEVANT_FIELDS)[number];

const norm = (v: unknown): string => {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "1" : "0";
  if (typeof v === "number") return String(v);
  return String(v).trim();
};

export interface PushDecision {
  push: boolean;
  /** Names of the QB-relevant fields that actually moved. */
  changed: QbRelevantField[];
  /** Why we are not pushing, when we are not. */
  reason:
    | "changed"
    | "no_qb_relevant_change"
    | "never_synced"
    | "missing_list_id";
}

/**
 * Compare the vendor before and after the local write.
 *
 * A vendor with no real ListID was never created in QuickBooks — there is
 * nothing to modify, and a Mod against a `pending_` placeholder is a guaranteed
 * rejection. Those go through the existing create/force-resync path instead, so
 * this returns `never_synced` rather than pretending to have pushed.
 */
export function decideVendorPush(
  before: Record<string, unknown>,
  after: Record<string, unknown>
): PushDecision {
  const changed = QB_RELEVANT_FIELDS.filter(
    (f) => f in after && norm(after[f]) !== norm(before[f])
  );

  if (!changed.length) {
    return { push: false, changed, reason: "no_qb_relevant_change" };
  }

  const listId = norm(after.qb_list_id ?? before.qb_list_id);
  if (!listId) return { push: false, changed, reason: "missing_list_id" };
  if (listId.startsWith("pending_")) {
    return { push: false, changed, reason: "never_synced" };
  }

  return { push: true, changed, reason: "changed" };
}

/** Did the payment term specifically move? Drives the terms-only messaging. */
export function termChanged(
  before: Record<string, unknown>,
  after: Record<string, unknown>
): boolean {
  const b = before.terms_ref_name;
  const a = "terms_ref_name" in after ? after.terms_ref_name : b;
  if (b == null && a == null) return false;
  if (b == null || a == null) return true;
  return normalizeVendorTermKey(String(a)) !== normalizeVendorTermKey(String(b));
}

/** Map a `qb_vendor` row onto the snapshot the Mod builder expects. */
export function toVendorSnapshot(
  row: Record<string, unknown>
): QbVendorSnapshot {
  const str = (k: string): string | null => {
    const v = row[k];
    return v == null || String(v).trim() === "" ? null : String(v).trim();
  };
  return {
    qb_list_id: String(row.qb_list_id ?? ""),
    name: String(row.name ?? row.full_name ?? ""),
    company_name: str("company_name"),
    first_name: str("first_name"),
    middle_initial: str("middle_initial"),
    last_name: str("last_name"),
    contact: str("contact"),
    alt_contact: str("alt_contact"),
    name_on_check: str("name_on_check"),
    account_number: str("account_number"),
    notes: str("notes"),
    email: str("email"),
    phone: str("phone"),
    alt_phone: str("alt_phone"),
    fax: str("fax"),
    tax_identity: str("tax_identity"),
    vendor_type_ref_name: str("vendor_type_ref_name"),
    terms_ref_name: str("terms_ref_name"),
    credit_limit:
      row.credit_limit == null || row.credit_limit === ""
        ? null
        : Number(row.credit_limit),
    is_vendor_eligible_for_1099:
      typeof row.is_vendor_eligible_for_1099 === "boolean"
        ? row.is_vendor_eligible_for_1099
        : null,
    is_active: row.is_active === false ? false : true,
    address:
      str("addr1") || str("city") || str("state")
        ? {
            Addr1: str("addr1"),
            Addr2: str("addr2"),
            City: str("city"),
            State: str("state"),
            PostalCode: str("postal_code"),
            Country: str("country"),
          }
        : null,
  };
}

/**
 * Turn a push outcome into the two columns the vendor page already shows.
 *
 * `last_error` is CLEARED on success — a stale error next to a healthy sync
 * status is worse than no error at all, because it teaches the operator that
 * the field lies.
 */
export function syncStampForOutcome(
  outcome:
    | { ok: true }
    | { ok: false; statusCode: string | null; statusMessage: string }
): { sync_status: string; last_error: string | null } {
  if (outcome.ok) return { sync_status: "synced", last_error: null };
  const code = outcome.statusCode ? ` (${outcome.statusCode})` : "";
  return {
    sync_status: "error",
    last_error:
      `QuickBooks rejected the vendor update${code}: ` +
      (outcome.statusMessage || "no message returned"),
  };
}
