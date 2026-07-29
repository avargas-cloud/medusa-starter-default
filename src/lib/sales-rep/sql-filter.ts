/**
 * Sales-rep filter for the SQL-backed POS list routes.
 *
 * It lives in one place because every list route has TWO consumers that must
 * agree: the route that returns the rows, and the route that returns the count
 * labelling them. When only one honoured the rep, the list contradicted
 * itself — `/estimates` filtered its table by rep server-side while its badge
 * kept counting every rep, so picking AVP showed 5 rows under a badge of 185.
 *
 * The Meili-backed `/orders` routes have their own equivalent in
 * `api/admin/orders/_lib/rep-filter.ts`. This is the Postgres twin: same
 * intent, different engine.
 *
 * ── Why the OR list is built from non-empty values only ──────────────────────
 *
 * The predicate this replaces interpolated both the initials and the name
 * unconditionally:
 *
 *     COALESCE(o.metadata->'sales_rep'->>'initials', '') = ?   -- repInitials
 *
 * With a rep whose initials were absent, that binding was the empty string and
 * the clause matched every order that has NO rep at all — the widest possible
 * result, arrived at silently. Dropping empty values means a selection that
 * carries no usable token yields `null` (caller shows everything, explicitly)
 * instead of a filter that quietly means something broader than intended.
 *
 * ── Why initials and name are both matched against both fields ──────────────
 *
 * The POS compares the PARSED NAME of an order against the picked rep's
 * initials or name (`parse-sales-rep.ts` + the list pages), so a value can
 * legitimately land in either field. Production is currently 1,528 orders, all
 * of them the canonical `{ initials, name }` object across 5 distinct pairs, so
 * the cross-matching is defensive rather than load-bearing — but it mirrors the
 * client predicate instead of narrowing it, which is what keeps the row count
 * and the badge identical.
 */

/** Anything longer is not a rep token; refuse it rather than query with it. */
const MAX_REP_LENGTH = 64;

/** A safe SQL identifier — the alias is interpolated, never bound. */
const SAFE_ALIAS = /^[a-z_][a-z0-9_]*$/i;

export type RepSelection = {
  initials: string | null;
  name: string | null;
};

/** The "no rep picked" selection — every caller treats it as "show all". */
export const NO_REP: RepSelection = { initials: null, name: null };

/** Accepts a rep token from the query string, or null when absent/unusable. */
export function parseRepToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_REP_LENGTH
    ? trimmed
    : null;
}

/**
 * Reads a rep selection off a query object.
 *
 * Both spellings are accepted so the POS pages can keep the param names they
 * already send: `/estimates` uses `repInitials`/`repName`, `/orders` uses
 * `rep`/`rep_name`.
 */
export function parseRepSelection(
  query: Record<string, unknown>
): RepSelection {
  return {
    initials: parseRepToken(query.repInitials ?? query.rep),
    name: parseRepToken(query.repName ?? query.rep_name),
  };
}

/** True when the selection carries at least one usable token. */
export function hasRepSelection(selection: RepSelection): boolean {
  return selection.initials !== null || selection.name !== null;
}

/**
 * Builds the SQL predicate for a rep selection, or `null` for "All".
 *
 * `alias` is the table alias of the `order` row (interpolated, so it is
 * validated as an identifier). Values are returned as knex `?` bindings — these
 * routes run through `__pg_connection__`, which uses `?`, not `$1`.
 */
export function repSqlPredicate(
  selection: RepSelection,
  alias: string
): { sql: string; bindings: string[] } | null {
  if (!SAFE_ALIAS.test(alias)) {
    throw new Error(`repSqlPredicate: unsafe table alias "${alias}"`);
  }

  const wanted = [
    ...new Set(
      [selection.initials, selection.name].filter(
        (value): value is string => value !== null
      )
    ),
  ];
  if (wanted.length === 0) return null;

  const placeholders = wanted.map(() => "?").join(", ");
  const sql = `(
    COALESCE(${alias}.metadata->'sales_rep'->>'initials', '') IN (${placeholders})
    OR COALESCE(${alias}.metadata->'sales_rep'->>'name', '') IN (${placeholders})
  )`;

  return { sql, bindings: [...wanted, ...wanted] };
}
