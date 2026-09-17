/**
 * Vencimientos del DR-15 de Florida (sales-tax-center-20260917). Puro: fechas
 * como strings `YYYY-MM-DD` en ET, sin `Date` local (la regla de la casa: un
 * `new Date('2026-04-22')` corre un día atrás).
 *
 * Reglas (DR-15N, "Due Dates" + "Electronic Payments"):
 *   - La declaración y el pago del período M vencen el día 1 del mes M+1 y son
 *     TARDÍOS después del 20. Si el 20 cae sábado, domingo o feriado estatal /
 *     federal, es a tiempo el primer día hábil siguiente.
 *   - Un pago electrónico es a tiempo si se INICIA (con confirmación) antes de
 *     las 5:00 p.m. ET del día hábil ANTERIOR al 20 — el 20 literal, no el
 *     corrido: para septiembre 2026 (20 = domingo) la declaración puede entrar
 *     el lunes 21, pero el ACH tiene que iniciarse el viernes 18.
 *
 * Feriados: los federales observados + los estatales de Florida que cierran el
 * DOR (Good Friday no; el día después de Thanksgiving sí). Lista corta y
 * calculada por regla — una lista mantenida a mano es la que se olvida.
 */

export interface FilingDueDates {
  /** Período `YYYY-MM`. */
  period: string;
  /** Primer día hábil del mes siguiente en que el DR-15 se puede presentar. */
  opens_on: string;
  /** El 20 literal del mes siguiente (después de este día es tardío, salvo corrida). */
  statutory_due: string;
  /** Día hasta el que la declaración es a tiempo (el 20 o el hábil siguiente). */
  filing_due: string;
  /** Último día para INICIAR el pago electrónico (hábil anterior al 20 literal), 5 pm ET. */
  epay_cutoff: string;
}

const pad = (n: number): string => String(n).padStart(2, "0");

export function ymd(y: number, m: number, d: number): string {
  return `${y}-${pad(m)}-${pad(d)}`;
}

function parts(day: string): [number, number, number] {
  const [y = 0, m = 0, d = 0] = day.split("-").map(Number);
  return [y, m, d];
}

function ym(period: string): [number, number] {
  const [y = 0, m = 0] = period.split("-").map(Number);
  return [y, m];
}

/** Días desde la época (UTC) — sólo para aritmética de calendario. */
function toDays(day: string): number {
  const [y, m, d] = parts(day);
  return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
}

function fromDays(days: number): string {
  const dt = new Date(days * 86_400_000);
  return ymd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

export function addDays(day: string, n: number): string {
  return fromDays(toDays(day) + n);
}

/** 0 = domingo … 6 = sábado. */
export function weekday(day: string): number {
  return ((toDays(day) % 7) + 11) % 7; // 1970-01-01 fue jueves (4)
}

function nthWeekdayOfMonth(y: number, m: number, wd: number, n: number): string {
  const first = ymd(y, m, 1);
  const offset = (wd - weekday(first) + 7) % 7;
  return addDays(first, offset + (n - 1) * 7);
}

function lastWeekdayOfMonth(y: number, m: number, wd: number): string {
  const nextFirst = m === 12 ? ymd(y + 1, 1, 1) : ymd(y, m + 1, 1);
  const last = addDays(nextFirst, -1);
  const back = (weekday(last) - wd + 7) % 7;
  return addDays(last, -back);
}

/** Feriado fijo observado: sábado → viernes, domingo → lunes. */
function observed(day: string): string {
  const wd = weekday(day);
  if (wd === 6) return addDays(day, -1);
  if (wd === 0) return addDays(day, 1);
  return day;
}

/** Feriados (observados) del año en que cierra el Florida DOR. */
export function holidaysFor(year: number): Set<string> {
  const thanksgiving = nthWeekdayOfMonth(year, 11, 4, 4);
  return new Set([
    observed(ymd(year, 1, 1)), // New Year's Day
    nthWeekdayOfMonth(year, 1, 1, 3), // MLK Day
    nthWeekdayOfMonth(year, 2, 1, 3), // Presidents' Day
    lastWeekdayOfMonth(year, 5, 1), // Memorial Day
    observed(ymd(year, 6, 19)), // Juneteenth
    observed(ymd(year, 7, 4)), // Independence Day
    nthWeekdayOfMonth(year, 9, 1, 1), // Labor Day
    observed(ymd(year, 11, 11)), // Veterans Day
    thanksgiving,
    addDays(thanksgiving, 1), // día después de Thanksgiving (estatal FL)
    observed(ymd(year, 12, 25)), // Christmas
  ]);
}

export function isBusinessDay(day: string): boolean {
  const wd = weekday(day);
  if (wd === 0 || wd === 6) return false;
  return !holidaysFor(parts(day)[0]).has(day);
}

export function nextBusinessDayOnOrAfter(day: string): string {
  let d = day;
  while (!isBusinessDay(d)) d = addDays(d, 1);
  return d;
}

export function previousBusinessDayBefore(day: string): string {
  let d = addDays(day, -1);
  while (!isBusinessDay(d)) d = addDays(d, -1);
  return d;
}

export function isPeriod(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

export function periodBounds(period: string): { from: string; to: string } {
  const [y, m] = ym(period);
  const from = ymd(y, m, 1);
  const nextFirst = m === 12 ? ymd(y + 1, 1, 1) : ymd(y, m + 1, 1);
  return { from, to: addDays(nextFirst, -1) };
}

export function nextPeriod(period: string): string {
  const [y, m] = ym(period);
  return m === 12 ? `${y + 1}-01` : `${y}-${pad(m + 1)}`;
}

export function previousPeriod(period: string): string {
  const [y, m] = ym(period);
  return m === 1 ? `${y - 1}-12` : `${y}-${pad(m - 1)}`;
}

/** El período de un pago hecho el día `day`: el mes ANTERIOR (se paga en M+1). */
export function periodOfPaymentDay(day: string): string {
  return previousPeriod(day.slice(0, 7));
}

export function filingDueDates(period: string): FilingDueDates {
  const [y, m] = ym(nextPeriod(period));
  const first = ymd(y, m, 1);
  const twentieth = ymd(y, m, 20);
  return {
    period,
    opens_on: nextBusinessDayOnOrAfter(first),
    statutory_due: twentieth,
    filing_due: nextBusinessDayOnOrAfter(twentieth),
    epay_cutoff: previousBusinessDayBefore(twentieth),
  };
}

export type FilingUrgency = "upcoming" | "due_soon" | "overdue" | "not_open";

/** Estado del vencimiento visto desde `today` (ET). `due_soon` = quedan ≤ 5 días para el corte del ACH. */
export function filingUrgency(due: FilingDueDates, today: string): FilingUrgency {
  if (today < due.opens_on) return "not_open";
  if (today > due.filing_due) return "overdue";
  if (toDays(due.epay_cutoff) - toDays(today) <= 5) return "due_soon";
  return "upcoming";
}
