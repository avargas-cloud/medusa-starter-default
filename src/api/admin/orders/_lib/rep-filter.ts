/**
 * Sales-rep filter shared by the POS orders list routes (`filter` and
 * `counts`).
 *
 * It lives here, in one place, because the two routes MUST agree: `counts`
 * feeds the tab badges and `filter` feeds the table underneath them. When only
 * one of the two honoured the rep, the badge said 1210 while the table it
 * labelled showed 108 — the list contradicted itself.
 *
 * Why the filter was moved server-side at all: the POS used to apply it in the
 * browser over whichever rows had already been fetched. On the All tab that is
 * the most-recent-200 feed, so rep MFP showed 108 of its 593 orders, and rep
 * JTV — whose 2 orders are both older than that window — showed as having none
 * at all.
 */

const MAX_REP_LENGTH = 64;

/**
 * Renders a value as a Meili filter literal.
 *
 * Meili filter literals are double-quoted, so the two characters that could
 * terminate one are removed rather than escaped. Every real value here is a
 * short initials or name token, which makes stripping lossless — and it cannot
 * yield a filter that quietly means something broader than intended.
 */
export function meiliLiteral(value: string): string {
  return `"${value.replace(/["\\]/g, "")}"`;
}

/** Accepts a rep token from the query string, or null when absent/unusable. */
export function parseRep(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_REP_LENGTH
    ? trimmed
    : null;
}

/**
 * Builds the Meili filter clauses for a rep selection, or `[]` for "All".
 *
 * Both the initials and the name are matched against the single
 * `sales_rep_initials` field: `build-order-doc` contributes the initials when
 * `metadata.sales_rep` is an object and the raw string when it is a bare
 * string, so either value can be what landed in the index. This mirrors the
 * POS predicate (initials OR name, against either field) instead of narrowing
 * it. Production data is currently all objects with clean initials, so the
 * name arm is defensive rather than load-bearing.
 */
export function repFilter(
  rep: string | null,
  repName: string | null
): string[] {
  const wanted = [rep, repName].filter((value): value is string => value !== null);
  if (wanted.length === 0) return [];
  const clauses = [...new Set(wanted)].map(
    (value) => `sales_rep_initials = ${meiliLiteral(value)}`
  );
  return [`(${clauses.join(" OR ")})`];
}
