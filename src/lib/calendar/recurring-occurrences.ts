/**
 * src/lib/calendar/recurring-occurrences.ts
 *
 * Generador PURO de vencimientos. Trabaja con días de calendario (`YYYY-MM-DD`)
 * y aritmética sobre `Date.UTC` usada sólo como contador de días: acá no hay
 * instantes ni zonas horarias — el día de negocio es ET por definición y el
 * DST no puede correr nada porque nunca se convierte a hora.
 *
 * Política de fin de mes (regla mensual el 31, o el 29/30):
 *   · last_day          → cae el último día del mes (28 en febrero)
 *   · skip              → ese mes no tiene vencimiento
 *   · next_business_day → el primer lunes-viernes del mes siguiente
 *
 * `period_key` es la fecha NOMINAL (antes de aplicar la política), así la
 * ocurrencia es única por regla+período aunque la fecha efectiva se mueva.
 *
 * // ATAJO: día hábil = lunes a viernes; feriados no se contemplan (techo:
 * // una regla next_business_day que cae en feriado); disparador: el contador
 * // lo pide o el casador del feed muestra un desfase repetido.
 */
import type { Frequency, RecurringRuleInput } from "./recurring-types";

export interface GeneratedOccurrence {
  period_key: string;
  due_date: string;
}

type Ymd = { y: number; m: number; d: number }; // m 1-12

export function parseYmd(iso: string): Ymd {
  return { y: Number(iso.slice(0, 4)), m: Number(iso.slice(5, 7)), d: Number(iso.slice(8, 10)) };
}

export function formatYmd({ y, m, d }: Ymd): string {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function fromUtc(t: number): Ymd {
  const dt = new Date(t);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

function toUtc({ y, m, d }: Ymd): number {
  return Date.UTC(y, m - 1, d);
}

export function addDays(iso: string, days: number): string {
  return formatYmd(fromUtc(toUtc(parseYmd(iso)) + days * 86_400_000));
}

export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** 0 = domingo … 6 = sábado (igual que `Date#getUTCDay`). */
export function weekdayOf(iso: string): number {
  return new Date(toUtc(parseYmd(iso))).getUTCDay();
}

export function isBusinessDay(iso: string): boolean {
  const wd = weekdayOf(iso);
  return wd >= 1 && wd <= 5;
}

export function nextBusinessDay(iso: string): string {
  let cur = iso;
  while (!isBusinessDay(cur)) cur = addDays(cur, 1);
  return cur;
}

type RuleShape = Pick<
  RecurringRuleInput,
  "frequency" | "day_of_month" | "weekday" | "month_of_year" | "end_of_month_policy" | "start_date" | "end_date"
>;

/** Aplica la política de fin de mes a (y, m, día pedido). `null` = ese mes se salta. */
function resolveMonthly(rule: RuleShape, y: number, m: number): GeneratedOccurrence | null {
  const wanted = rule.day_of_month ?? 1;
  const last = daysInMonth(y, m);
  const nominal = formatYmd({ y, m, d: Math.min(wanted, last) });
  if (wanted <= last) return { period_key: nominal, due_date: nominal };
  switch (rule.end_of_month_policy) {
    case "skip":
      return null;
    case "next_business_day": {
      const firstNext = m === 12 ? formatYmd({ y: y + 1, m: 1, d: 1 }) : formatYmd({ y, m: m + 1, d: 1 });
      return { period_key: nominal, due_date: nextBusinessDay(firstNext) };
    }
    case "last_day":
    default:
      return { period_key: nominal, due_date: nominal };
  }
}

function monthStep(freq: Frequency): number {
  return freq === "quarterly" ? 3 : freq === "yearly" ? 12 : 1;
}

/**
 * Vencimientos de `rule` con `due_date` en [from, to] (ambos inclusive), sin
 * salirse de [start_date, end_date]. Ordenados. Puro y determinista.
 */
export function generateOccurrences(rule: RuleShape, from: string, to: string): GeneratedOccurrence[] {
  const lo = from > rule.start_date ? from : rule.start_date;
  const hi = rule.end_date && rule.end_date < to ? rule.end_date : to;
  if (lo > hi) return [];
  const out: GeneratedOccurrence[] = [];

  if (rule.frequency === "weekly" || rule.frequency === "biweekly") {
    // Ancla: el primer día >= start_date con el weekday pedido (weekly), o la
    // propia start_date cada 14 días (biweekly).
    let cur = rule.start_date;
    if (rule.frequency === "weekly") {
      const want = rule.weekday ?? weekdayOf(rule.start_date);
      while (weekdayOf(cur) !== want) cur = addDays(cur, 1);
    }
    const step = rule.frequency === "weekly" ? 7 : 14;
    // Saltar en bloque hasta cerca de `lo` para no iterar años día a día.
    if (cur < lo) {
      const gapDays = Math.floor((toUtc(parseYmd(lo)) - toUtc(parseYmd(cur))) / 86_400_000);
      cur = addDays(cur, Math.floor(gapDays / step) * step);
    }
    while (cur <= hi) {
      if (cur >= lo) out.push({ period_key: cur, due_date: cur });
      cur = addDays(cur, step);
    }
    return out;
  }

  // monthly / quarterly / yearly: recorrer meses desde el mes de start_date.
  const start = parseYmd(rule.start_date);
  const step = monthStep(rule.frequency);
  let y = start.y;
  let m = rule.frequency === "yearly" ? (rule.month_of_year ?? start.m) : start.m;
  // Un yearly cuyo mes ya pasó en el año de inicio arranca el año siguiente.
  if (rule.frequency === "yearly" && formatYmd({ y, m, d: daysInMonth(y, m) }) < rule.start_date) y += 1;

  const hiYmd = parseYmd(hi);
  while (y < hiYmd.y || (y === hiYmd.y && m <= hiYmd.m + 1)) {
    const occ = resolveMonthly(rule, y, m);
    // La política next_business_day puede empujar al mes siguiente, por eso el
    // loop mira un mes más allá de `hi` y filtra por due_date.
    if (occ && occ.due_date >= lo && occ.due_date <= hi && occ.period_key >= rule.start_date) out.push(occ);
    m += step;
    while (m > 12) {
      m -= 12;
      y += 1;
    }
  }
  return out.sort((a, b) => (a.due_date < b.due_date ? -1 : a.due_date > b.due_date ? 1 : 0));
}

/** `overdue` es una lectura, no un estado: esperado y con la fecha ya pasada. */
export function viewStatus(status: "expected" | "paid" | "skipped", dueDate: string, todayEt: string) {
  return status === "expected" && dueDate < todayEt ? ("overdue" as const) : status;
}
