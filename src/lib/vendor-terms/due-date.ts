/**
 * Bill date + term → due date.
 *
 * Everything here operates on `YYYY-MM-DD` strings and never constructs a
 * `Date` from one. A `new Date("2026-07-31")` is parsed as UTC midnight and
 * then rendered in local time, so in any negative-offset zone — which is every
 * zone this company operates in — it prints as the 30th. The POS works around
 * this today by anchoring at noon; doing the arithmetic on calendar components
 * removes the class of bug instead of dodging it.
 */

import { isDateDriven } from "./types";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

interface Ymd {
  y: number;
  m: number; // 1-12
  d: number; // 1-31
}

export function parseYmd(iso: string): Ymd | null {
  if (!DATE_RE.test(iso)) return null;
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  const d = Number(iso.slice(8, 10));
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
  return { y, m, d };
}

export function formatYmd({ y, m, d }: Ymd): string {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(
    d
  ).padStart(2, "0")}`;
}

export function daysInMonth(y: number, m: number): number {
  // Day 0 of month m+1 is the last day of month m. UTC so no zone shifts.
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Days between two calendar dates, b - a. Both must be valid. */
export function daysBetween(a: Ymd, b: Ymd): number {
  const MS_PER_DAY = 86_400_000;
  const ua = Date.UTC(a.y, a.m - 1, a.d);
  const ub = Date.UTC(b.y, b.m - 1, b.d);
  return Math.round((ub - ua) / MS_PER_DAY);
}

export function addDays(base: Ymd, days: number): Ymd {
  const t = new Date(Date.UTC(base.y, base.m - 1, base.d + days));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/**
 * Day `dom` of month (y, m), clamped to the last real day. A term due on the
 * 31st has no 31st in February — QuickBooks bills it on the 28th/29th rather
 * than skipping the month, and so do we.
 */
export function dayOfMonthIn(y: number, m: number, dom: number): Ymd {
  return { y, m, d: Math.min(dom, daysInMonth(y, m)) };
}

export function addMonths(base: Ymd, months: number): Ymd {
  const total = (base.y * 12 + (base.m - 1)) + months;
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  return dayOfMonthIn(y, m, base.d);
}

export interface DueDateTerm {
  days: number | null;
  day_of_month_due: number | null;
  due_next_month_days?: number | null;
}

/**
 * Resolve the due date for a bill.
 *
 * Returns `null` when the term carries no usable rule or the bill date is not a
 * calendar date. Callers must treat `null` as "unknown" and leave the field for
 * a human — NEVER as day zero. Defaulting an unresolvable term to "due today"
 * is precisely how a vendor with no term ended up with bills that read as
 * overdue the moment they were created.
 */
export function resolveDueDate(
  billDateIso: string,
  term: DueDateTerm
): string | null {
  const bill = parseYmd(billDateIso);
  if (!bill) return null;

  if (isDateDriven(term)) {
    const dom = term.day_of_month_due as number;
    if (!Number.isInteger(dom) || dom < 1 || dom > 31) return null;
    return formatYmd(resolveDateDriven(bill, dom, term.due_next_month_days));
  }

  const days = term.days;
  if (days == null || !Number.isInteger(days) || days < 0) return null;
  return formatYmd(addDays(bill, days));
}

/**
 * QuickBooks' date-driven rule: the bill is due on day `dom`, but if it lands
 * too close to that day it rolls to the following month. `dueNextMonthDays` is
 * how much runway QB insists on — a bill dated the 19th for a term due on the
 * 20th with 10 days of grace is due the 20th of NEXT month, not tomorrow.
 *
 * A due day that has already passed in the bill's own month always rolls; that
 * part needs no grace setting and holds even when `dueNextMonthDays` is 0.
 */
function resolveDateDriven(
  bill: Ymd,
  dom: number,
  dueNextMonthDays: number | null | undefined
): Ymd {
  const grace =
    dueNextMonthDays != null && Number.isInteger(dueNextMonthDays)
      ? Math.max(0, dueNextMonthDays)
      : 0;

  const thisMonth = dayOfMonthIn(bill.y, bill.m, dom);
  const gap = daysBetween(bill, thisMonth);

  if (gap < 0 || gap < grace) {
    const next = addMonths({ y: bill.y, m: bill.m, d: 1 }, 1);
    return dayOfMonthIn(next.y, next.m, dom);
  }
  return thisMonth;
}
