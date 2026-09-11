// QB document dates should reflect the local business calendar of the
// store, not UTC. Florida is America/New_York; override via env if the
// company books in another timezone.
export const BUSINESS_TIMEZONE = process.env.QB_DOC_TIMEZONE || "America/New_York";

/**
 * Returns YYYY-MM-DD for the given instant in the store's local timezone.
 * Falls back to "today" only when no source date is supplied. Callers that
 * represent a real business event (order/fulfillment/pos_invoice) MUST pass
 * the source date so QB <TxnDate> stays stable across retries.
 */
export function getBusinessDateString(date?: string | Date | null): string {
  const d = date ? new Date(date) : new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: BUSINESS_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const dd = parts.find((p) => p.type === "day")?.value;
  return `${y}-${m}-${dd}`;
}

/**
 * Returns the UTC instant corresponding to ET midnight (00:00) of the given
 * calendar date (year, monthIndex 0-based, day). Tries both possible ET
 * offsets (EDT -4 / EST -5) and picks the candidate whose America/New_York
 * wall-clock reads 00:00 on the requested calendar date.
 */
export function etMidnightUtc(year: number, monthIndex: number, day = 1): Date {
  // Normalize (handles monthIndex overflow, e.g. monthIndex=12 → next Jan).
  const normalized = new Date(Date.UTC(year, monthIndex, day));
  const expectedY = String(normalized.getUTCFullYear());
  const expectedM = String(normalized.getUTCMonth() + 1).padStart(2, "0");
  const expectedD = String(normalized.getUTCDate()).padStart(2, "0");

  for (const offsetHours of [4, 5]) {
    const candidate = new Date(
      Date.UTC(normalized.getUTCFullYear(), normalized.getUTCMonth(), normalized.getUTCDate(), offsetHours, 0, 0, 0)
    );
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: BUSINESS_TIMEZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
    }).formatToParts(candidate);
    const y = parts.find((p) => p.type === "year")?.value;
    const m = parts.find((p) => p.type === "month")?.value;
    const dd = parts.find((p) => p.type === "day")?.value;
    const hh = parts.find((p) => p.type === "hour")?.value;
    if (y === expectedY && m === expectedM && dd === expectedD && hh === "00") {
      return candidate;
    }
  }
  // Fallback: should be unreachable for valid ET offsets, but keep a
  // deterministic result instead of throwing.
  return new Date(
    Date.UTC(normalized.getUTCFullYear(), normalized.getUTCMonth(), normalized.getUTCDate(), 5, 0, 0, 0)
  );
}

/**
 * A Postgres `date` column has no timezone — node-postgres parses it with
 * `new Date(year, monthIndex, day)`, i.e. LOCAL midnight, so the calendar
 * date is recoverable only through the LOCAL getters (`getFullYear` /
 * `getMonth` / `getDate`). `toISOString()` converts to UTC first and would
 * shift the date backward by one day on any host whose local timezone is
 * behind UTC (this box runs UTC-negative) — that mismatch is exactly what
 * fed a JS `Date` into `assertBankAccountingPeriodOpen` (which validates a
 * strict `YYYY-MM-DD` string) and raised `BANKING_INVALID_ACCOUNTING_DATE`.
 * A string input (already `YYYY-MM-DD`, e.g. a value never round-tripped
 * through pg) passes through unchanged.
 */
export function pgDateToIso(value: Date | string): string {
  if (typeof value === "string") return value.slice(0, 10);
  const y = value.getFullYear();
  const m = String(value.getMonth() + 1).padStart(2, "0");
  const d = String(value.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
