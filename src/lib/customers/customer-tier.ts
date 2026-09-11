/**
 * Single predicate for the customer price tier.
 *
 * The `Wholesale` customer group is the SINGLE TRUTH for the tier — no group
 * ⇒ Retail. `is_wholesale` / `price_level` / `qb_price_level` (top-level or
 * under `metadata`, written by the QuickBooks sync) are INPUT SIGNALS, not
 * the truth themselves: `reconcile-customer-groups.ts` converts them into
 * group membership. The metadata branch here is TRANSITIONAL — it only
 * matters for the window between a signal landing on the customer and the
 * reconciler (subscriber-driven) actually running and adding the group. Once
 * every customer has been reconciled at least once, the metadata branch is
 * theoretically dead code, but it is kept as a fail-safe: a caller that reads
 * the customer with `groups` unresolved/unpopulated (e.g. a partial
 * `query.graph` projection) still gets the right tier from the signal.
 *
 * Mirrors `store-pos/lib/customer-type.ts` (`getCustomerType`), but with the
 * order flipped: there the group check is a legacy fallback (step 3); here
 * the group is checked FIRST because it is the truth, and the metadata/
 * top-level fields are the fallback used only until the group reflects it.
 */

export type CustomerTier = "wholesale" | "retail";

export interface CustomerTierInput {
  groups?: ReadonlyArray<{ name?: string | null } | null> | null;
  metadata?: Record<string, unknown> | null;
  is_wholesale?: unknown;
  price_level?: unknown;
  qb_price_level?: unknown;
}

const WHOLESALE_GROUP_NAME_RE = /^wholesale$/i;
const WHOLESALE_SUBSTRING_RE = /wholesale/i;

function isTruthyWholesaleFlag(value: unknown): boolean {
  return value === true || value === "true";
}

function isWholesaleString(value: unknown): boolean {
  return typeof value === "string" && WHOLESALE_SUBSTRING_RE.test(value);
}

export function resolveCustomerTier(
  c: CustomerTierInput | null | undefined
): CustomerTier {
  if (!c) return "retail";

  // 1. Groups — the truth. Exact match (case-insensitive) against the group
  //    named exactly "Wholesale"; a group like "Wholesale Distributor" does
  //    NOT match (it is a different group, not a synonym for the tier).
  const groups = c.groups ?? [];
  if (groups.some((g) => WHOLESALE_GROUP_NAME_RE.test(g?.name ?? ""))) {
    return "wholesale";
  }

  // 2. Top-level input signals (transitional, until the reconciler runs).
  if (isTruthyWholesaleFlag(c.is_wholesale)) return "wholesale";
  if (isWholesaleString(c.qb_price_level)) return "wholesale";
  if (isWholesaleString(c.price_level)) return "wholesale";

  // 3. metadata input signals (same fields, transitional).
  const meta = (c.metadata ?? {}) as Record<string, unknown>;
  if (isTruthyWholesaleFlag(meta.is_wholesale)) return "wholesale";
  if (isWholesaleString(meta.price_level)) return "wholesale";
  if (isWholesaleString(meta.qb_price_level)) return "wholesale";

  return "retail";
}

export function isWholesaleTier(
  c: CustomerTierInput | null | undefined
): boolean {
  return resolveCustomerTier(c) === "wholesale";
}
