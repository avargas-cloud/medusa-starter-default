/**
 * batch-day.ts — merchant batch day derivation for customer payments.
 *
 * The merchant credit-card processor closes its batch at a cutoff time
 * (default 18:45 ET). A payment taken strictly AFTER the cutoff belongs to
 * the NEXT day's merchant batch. `batch_day` is the canonical ET business
 * date consumed by the payments dashboard, the print report, and the QB
 * TxnDate for POS-created Invoice / Sales Receipt / ReceivePayment docs.
 *
 * Boundary semantics: a payment at exactly HH:MM:00.000 stays on the same
 * day; anything past it (e.g. 18:45:30) rolls to the next day.
 *
 * The cutoff lives in store.metadata.payment_batch_cutoff ("HH:MM", ET) so
 * it is editable from the POS settings UI — cached in-memory for 60s here
 * (multi-instance deployments converge within the TTL).
 */
import { getDbPool } from "../../api/utils/db-pool";

// Same timezone primitive as getBusinessDateString (order-flow-core.ts).
const BATCH_TIMEZONE = process.env.QB_DOC_TIMEZONE || "America/New_York";

export const DEFAULT_BATCH_CUTOFF = { h: 18, m: 45 };

export interface BatchCutoff {
  h: number;
  m: number;
}

// ── Cutoff loader (store.metadata, 60s TTL cache) ─────────────────────────

const CUTOFF_TTL_MS = 60_000;
let cutoffCache: { value: BatchCutoff; loadedAt: number } | null = null;

export function parseCutoff(raw: string | null | undefined): BatchCutoff | null {
  if (!raw) return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return { h, m };
}

export async function getBatchCutoff(): Promise<BatchCutoff> {
  const now = Date.now();
  if (cutoffCache && now - cutoffCache.loadedAt < CUTOFF_TTL_MS) {
    return cutoffCache.value;
  }
  let value = DEFAULT_BATCH_CUTOFF;
  try {
    const pool = getDbPool();
    const { rows } = await pool.query<{ cutoff: string | null }>(
      `SELECT metadata->>'payment_batch_cutoff' AS cutoff FROM store LIMIT 1`
    );
    value = parseCutoff(rows[0]?.cutoff) ?? DEFAULT_BATCH_CUTOFF;
  } catch {
    // non-fatal — fall back to default (or last cached value)
    value = cutoffCache?.value ?? DEFAULT_BATCH_CUTOFF;
  }
  cutoffCache = { value, loadedAt: now };
  return value;
}

/** Called by the settings PUT so the current process applies immediately. */
export function invalidateBatchCutoffCache(): void {
  cutoffCache = null;
}

// ── Core derivation ────────────────────────────────────────────────────────

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Compute the merchant batch day ('YYYY-MM-DD', ET) for an instant.
 *
 * DST-safe: the "advance one day" step is pure calendar math over the ET
 * Y/M/D components (Date.UTC normalizes month/year rollover), never
 * arithmetic on the instant itself.
 */
export function computeBatchDay(
  receivedAt: string | Date | null | undefined,
  cutoff: BatchCutoff = DEFAULT_BATCH_CUTOFF,
  tz: string = BATCH_TIMEZONE
): string {
  const instant = receivedAt ? new Date(receivedAt) : new Date();
  const safe = Number.isNaN(instant.getTime()) ? new Date() : instant;

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(safe);

  const get = (type: string): number =>
    Number(parts.find((p) => p.type === type)?.value ?? "0");

  let y = get("year");
  let mo = get("month");
  let d = get("day");
  // Intl can emit hour "24" for midnight in some engines — normalize.
  const hh = get("hour") % 24;
  const mm = get("minute");
  const ss = get("second");

  const secondsOfDay = hh * 3600 + mm * 60 + ss;
  const cutoffSeconds = cutoff.h * 3600 + cutoff.m * 60;

  if (secondsOfDay > cutoffSeconds) {
    // Advance one ET calendar day (Date.UTC handles month/year rollover).
    const next = new Date(Date.UTC(y, mo - 1, d + 1));
    y = next.getUTCFullYear();
    mo = next.getUTCMonth() + 1;
    d = next.getUTCDate();
  }

  return `${y}-${pad(mo)}-${pad(d)}`;
}

/** ET calendar date of an instant WITHOUT the cutoff rule (backfill semantics). */
export function etDateString(
  receivedAt: string | Date | null | undefined,
  tz: string = BATCH_TIMEZONE
): string {
  // Cutoff at 24:00 → secondsOfDay can never exceed it → no day advance.
  return computeBatchDay(receivedAt, { h: 24, m: 0 }, tz);
}

/** Round-trip validation: true only for a real zero-padded YYYY-MM-DD date. */
export function isValidBatchDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const dt = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(dt.getTime()) && dt.toISOString().slice(0, 10) === value;
}
