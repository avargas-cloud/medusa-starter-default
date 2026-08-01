/**
 * Reading the vendor payment-terms catalog out of `system_defaults`.
 *
 * The row mapper is pure and shared; the two readers exist because this repo
 * has two SQL drivers with INCOMPATIBLE placeholder syntax — `knex.raw` (via
 * `__pg_connection__`) binds with `?`, the pg pool binds with `$1`. Mixing them
 * throws "Expected 1 bindings, saw 0" at runtime and nothing catches it earlier,
 * so each caller uses the reader that matches the connection it already holds
 * rather than passing a connection into an adapter that guesses.
 */

import {
  VENDOR_TERMS_CONTEXT,
  VENDOR_TERMS_FIELD,
  isValidTerm,
  normalizeVendorTermKey,
  type VendorTermOption,
} from "./types";

/** Shape every reader selects. Column order is irrelevant — mapped by name. */
const COLUMNS = `id, value, sort_order, metadata`;

const WHERE = `context = {0} AND field_name = {1}`;

const ORDER = `ORDER BY sort_order, value`;

export interface RawTermRow {
  id: string;
  value: string;
  sort_order: number | string | null;
  metadata: unknown;
}

const toInt = (raw: unknown): number | null => {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = Number(raw);
  return Number.isInteger(n) ? n : null;
};

/**
 * Map one `system_defaults` row to an option.
 *
 * Returns `null` for a row whose metadata carries no usable rule. Such a row is
 * data corruption, not a term: surfacing it in a dropdown would let an operator
 * pick something that resolves to no due date at all. Callers that need to
 * report the damage use `readVendorTermsWithRejects`.
 */
export function parseTermRow(row: RawTermRow): VendorTermOption | null {
  const name = typeof row.value === "string" ? row.value.trim() : "";
  if (!name) return null;

  const meta = (
    row.metadata && typeof row.metadata === "object" ? row.metadata : {}
  ) as Record<string, unknown>;

  const days = toInt(meta.days);
  const day_of_month_due = toInt(meta.day_of_month_due);

  if (!isValidTerm({ days, day_of_month_due })) return null;

  return {
    id: String(row.id),
    name,
    days,
    day_of_month_due,
    due_next_month_days: toInt(meta.due_next_month_days),
    exists_in_qb: meta.exists_in_qb === true,
    qb_synced_at:
      typeof meta.qb_synced_at === "string" ? meta.qb_synced_at : null,
    sort_order: toInt(row.sort_order) ?? 0,
  };
}

export interface TermsCatalog {
  options: VendorTermOption[];
  /** Rows that failed `parseTermRow`, by id — surfaced, never silently dropped. */
  rejected: { id: string; value: string }[];
}

export function buildCatalog(rows: RawTermRow[]): TermsCatalog {
  const options: VendorTermOption[] = [];
  const rejected: { id: string; value: string }[] = [];
  for (const row of rows) {
    const parsed = parseTermRow(row);
    if (parsed) options.push(parsed);
    else rejected.push({ id: String(row.id), value: String(row.value ?? "") });
  }
  return { options, rejected };
}

/** Case/whitespace-insensitive lookup by the name QuickBooks knows. */
export function findTermByName(
  catalog: Pick<TermsCatalog, "options">,
  name: string | null | undefined
): VendorTermOption | null {
  if (!name) return null;
  const key = normalizeVendorTermKey(name);
  return (
    catalog.options.find((o) => normalizeVendorTermKey(o.name) === key) ?? null
  );
}

export function findTermById(
  catalog: Pick<TermsCatalog, "options">,
  id: string | null | undefined
): VendorTermOption | null {
  if (!id) return null;
  return catalog.options.find((o) => o.id === id) ?? null;
}

// ── Readers ──────────────────────────────────────────────────────────────────

interface KnexLike {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
}

interface PgLike {
  query: (
    sql: string,
    values?: unknown[]
  ) => Promise<{ rows: unknown[] }>;
}

/** For routes holding a `__pg_connection__` knex instance (`?` placeholders). */
export async function readVendorTermsKnex(
  knex: KnexLike
): Promise<TermsCatalog> {
  const sql = `SELECT ${COLUMNS} FROM system_defaults WHERE ${WHERE.replace(
    "{0}",
    "?"
  ).replace("{1}", "?")} ${ORDER}`;
  const result = await knex.raw(sql, [
    VENDOR_TERMS_CONTEXT,
    VENDOR_TERMS_FIELD,
  ]);
  return buildCatalog((result.rows ?? []) as RawTermRow[]);
}

/** For routes and scripts holding a pg `Client`/`Pool` (`$1` placeholders). */
export async function readVendorTermsPg(client: PgLike): Promise<TermsCatalog> {
  const sql = `SELECT ${COLUMNS} FROM system_defaults WHERE ${WHERE.replace(
    "{0}",
    "$1"
  ).replace("{1}", "$2")} ${ORDER}`;
  const result = await client.query(sql, [
    VENDOR_TERMS_CONTEXT,
    VENDOR_TERMS_FIELD,
  ]);
  return buildCatalog((result.rows ?? []) as RawTermRow[]);
}
