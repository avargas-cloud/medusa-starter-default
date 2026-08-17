import { findTermByName, readVendorTermsKnex } from "../vendor-terms/catalog";

type PaymentTermsKnex = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
};

const DEFAULT_TERMS_DAYS = 0;
const MAX_TERMS_DAYS = 365;

/**
 * What a new vendor bill inherits from its vendor: the DAY COUNT that drives the
 * due date, and the NAME of the term that produced it.
 *
 * Both halves or the bill is only half-described. Until 2026-08-17 the three
 * create paths seeded the days alone, so every bill written since the
 * `payment_terms_name` column landed (2026-08-01) opened with its Terms
 * dropdown reading "— None —" while its Due Date was perfectly correct: 29 of
 * them in production. That is worse than cosmetic — the next Save PERSISTS the
 * empty dropdown as "no term", turning a display gap into data loss.
 *
 * The two halves come from two different places on the vendor, which is exactly
 * why they can disagree:
 *
 *   name → `qb_vendor.terms_ref_name`  (the canonical field; it is what a
 *          VendorMod sends to QuickBooks as TermsRef, so it is the one the
 *          company file actually agrees with)
 *   days → `qb_vendor.metadata.default_payment_terms_days`  (the operator-
 *          managed number the due date is computed from)
 *
 * `metadata.payment_terms` mirrors the name and is NOT read here. Measured
 * across all 1109 live vendors it agrees with `terms_ref_name` everywhere
 * except one, and that one is a genuine split brain a human has to settle —
 * reading the mirror would just pick a side quietly.
 *
 * A name is returned ONLY when the catalog term it points at carries the same
 * day count the vendor stored. Anything else returns `name: null`: a bill that
 * says "Net-30" while counting 21 days is a worse record than one that says
 * nothing, and the backfill script makes the same call for the same reason.
 */
export interface VendorBillPaymentTerms {
  days: number;
  name: string | null;
}

export async function resolveVendorBillPaymentTerms(
  knex: PaymentTermsKnex,
  vendorId: string | null | undefined
): Promise<VendorBillPaymentTerms> {
  if (!vendorId) return { days: DEFAULT_TERMS_DAYS, name: null };

  const result = await knex.raw(
    `SELECT metadata->>'default_payment_terms_days' AS payment_terms_days,
            terms_ref_name
       FROM qb_vendor
      WHERE id = ? AND deleted_at IS NULL
      LIMIT 1`,
    [vendorId]
  );
  const row = result.rows[0] as
    | { payment_terms_days?: unknown; terms_ref_name?: unknown }
    | undefined;

  const parsed = Number(row?.payment_terms_days);
  const days =
    Number.isInteger(parsed) && parsed >= 0 && parsed <= MAX_TERMS_DAYS
      ? parsed
      : DEFAULT_TERMS_DAYS;

  const termName =
    typeof row?.terms_ref_name === "string" ? row.terms_ref_name.trim() : "";
  if (!termName) return { days, name: null };

  // The catalog is the arbiter both halves have to agree with. A term the
  // vendor names but the catalog does not have carries no rule to check
  // against, so it is not a name this bill can claim either.
  const catalog = await readVendorTermsKnex(knex);
  const term = findTermByName(catalog, termName);

  return { days, name: term && term.days === days ? term.name : null };
}
