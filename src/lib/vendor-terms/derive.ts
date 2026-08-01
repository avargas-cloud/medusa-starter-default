/**
 * Deriving the initial term catalog from the vendors that already carry one.
 *
 * Production has 280 vendors whose term name and day count were synced from
 * QuickBooks over months. That history is the best offline seed there is — and
 * it is also where the disagreements live: 61 vendors say "Net-30" means 30
 * days and one says 21; 116 say "Due on receipt" means 0 and one says 30; a
 * term literally named "30 days" resolves to 0.
 *
 * So this module does NOT quietly pick a winner. It picks the reading held by
 * the most vendors — a tie breaks toward the smaller day count, because paying
 * early is the recoverable mistake — and it RETURNS every disagreement it
 * papered over. The caller is expected to print them. A seeding routine that
 * silently collapses 21 into 30 would erase the only evidence that a vendor was
 * negotiated separately.
 *
 * Names are grouped case/whitespace-insensitively but NOT by punctuation:
 * "Net 30" and "Net-30" are two distinct live terms in the company file.
 */

import { normalizeVendorTermKey } from "./types";

export interface VendorTermSighting {
  /** `qb_vendor.terms_ref_name` — the name QuickBooks uses. */
  name: string;
  days: number | null;
  day_of_month_due: number | null;
  /** How many vendors carry this exact (name, rule) combination. */
  vendors: number;
}

export interface DerivedTerm {
  name: string;
  days: number | null;
  day_of_month_due: number | null;
  /** Vendors backing the winning reading. */
  vendors: number;
}

export interface DerivedConflict {
  name: string;
  /** The reading that won, and the ones that lost — all with their vendor counts. */
  chosen: { days: number | null; day_of_month_due: number | null; vendors: number };
  rejected: {
    days: number | null;
    day_of_month_due: number | null;
    vendors: number;
  }[];
}

export interface DeriveResult {
  terms: DerivedTerm[];
  conflicts: DerivedConflict[];
  /** Names seen with no usable rule at all — excluded, never defaulted to 0. */
  ruleless: string[];
}

const hasRule = (s: {
  days: number | null;
  day_of_month_due: number | null;
}): boolean => s.days != null || s.day_of_month_due != null;

/**
 * Rank two readings of the same term name. More vendors wins. On a tie the
 * smaller day count wins; a date-driven reading loses to a standard one on a
 * tie because we cannot compare their magnitudes honestly.
 */
function beats(a: VendorTermSighting, b: VendorTermSighting): boolean {
  if (a.vendors !== b.vendors) return a.vendors > b.vendors;
  const aDays = a.days;
  const bDays = b.days;
  if (aDays != null && bDays != null) return aDays < bDays;
  if (aDays != null) return true;
  if (bDays != null) return false;
  return (a.day_of_month_due ?? 99) < (b.day_of_month_due ?? 99);
}

export function deriveTermsFromVendors(
  sightings: VendorTermSighting[]
): DeriveResult {
  const byName = new Map<string, VendorTermSighting[]>();
  const ruleless = new Set<string>();

  for (const s of sightings) {
    const name = (s.name ?? "").trim();
    if (!name) continue;
    if (!hasRule(s)) {
      ruleless.add(name);
      continue;
    }
    const key = normalizeVendorTermKey(name);
    const bucket = byName.get(key);
    if (bucket) bucket.push({ ...s, name });
    else byName.set(key, [{ ...s, name }]);
  }

  const terms: DerivedTerm[] = [];
  const conflicts: DerivedConflict[] = [];

  for (const bucket of byName.values()) {
    let winner: VendorTermSighting | undefined;
    for (const candidate of bucket) {
      if (!winner || beats(candidate, winner)) winner = candidate;
    }
    if (!winner) continue;

    terms.push({
      name: winner.name,
      days: winner.days,
      day_of_month_due: winner.day_of_month_due,
      vendors: bucket.reduce((n, s) => n + s.vendors, 0),
    });

    const losers = bucket.filter((s) => s !== winner);
    if (losers.length) {
      conflicts.push({
        name: winner.name,
        chosen: {
          days: winner.days,
          day_of_month_due: winner.day_of_month_due,
          vendors: winner.vendors,
        },
        rejected: losers.map((l) => ({
          days: l.days,
          day_of_month_due: l.day_of_month_due,
          vendors: l.vendors,
        })),
      });
    }
  }

  terms.sort((a, b) => b.vendors - a.vendors || a.name.localeCompare(b.name));
  conflicts.sort((a, b) => a.name.localeCompare(b.name));

  return {
    terms,
    conflicts,
    ruleless: [...ruleless].sort(),
  };
}

/**
 * Names that ASSERT a day count: "Net-30", "Net 30", "30 days", "30 Day".
 *
 * Deliberately narrow. A first pass matched any digit anywhere and flagged
 * "1 Year" (360 days), "6 Month" (180), "50% deposit, 50% upon delivery" (0)
 * and "1% 30-Net 45" (45) — all of them correct terms whose names simply are
 * not day counts. A checker that cries about four healthy rows to catch one
 * typo gets ignored, which is worse than not having it.
 *
 * The `%` guard is load-bearing on its own: discount-style names like
 * "1% 30-Net 45" and "2% 10 Net 30" put a number before the real due count.
 */
const DAY_COUNT_NAME =
  /^(?:net[\s-]*(\d{1,3})|(\d{1,3})\s*(?:days?|d)\.?)$/i;

/**
 * A term whose NAME states a day count that its own rule contradicts.
 *
 * Purely advisory — the name never overrides the rule. It exists because a term
 * literally named "30 days" resolving to 0 is almost certainly a typo, and a
 * human should see it in a list rather than discover it when a bill comes due a
 * month early.
 */
export function flagNameNumberMismatch(
  terms: Pick<DerivedTerm, "name" | "days">[]
): { name: string; days: number; nameSuggests: number }[] {
  const out: { name: string; days: number; nameSuggests: number }[] = [];
  for (const t of terms) {
    if (t.days == null) continue;
    const name = t.name.trim();
    if (name.includes("%")) continue;
    const m = DAY_COUNT_NAME.exec(name);
    if (!m) continue;
    const suggested = Number(m[1] ?? m[2]);
    if (!Number.isFinite(suggested)) continue;
    if (suggested !== t.days) {
      out.push({ name: t.name, days: t.days, nameSuggests: suggested });
    }
  }
  return out;
}
