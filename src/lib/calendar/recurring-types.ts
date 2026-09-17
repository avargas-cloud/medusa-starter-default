/**
 * src/lib/calendar/recurring-types.ts
 *
 * Tipos y validación de frontera del calendario de gastos recurrentes.
 * La UI manda campos simples (frecuencia + día), nunca un RRULE libre: cada
 * combinación acá listada tiene una prueba en `verify-calendars.ts`.
 */

export const FREQUENCIES = ["weekly", "biweekly", "monthly", "quarterly", "yearly"] as const;
export type Frequency = (typeof FREQUENCIES)[number];

export const EOM_POLICIES = ["last_day", "skip", "next_business_day"] as const;
export type EndOfMonthPolicy = (typeof EOM_POLICIES)[number];

export const AMOUNT_KINDS = ["fixed", "estimated"] as const;
export type AmountKind = (typeof AMOUNT_KINDS)[number];

export const DOCUMENT_KINDS = ["check", "expense", "bill"] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

/**
 * `booked` = existe un documento enlazado (draft o posted); lo pone el enlace,
 * nunca un PATCH manual. `paid` sigue siendo la afirmación del contador.
 */
export const OCCURRENCE_STATUSES = ["expected", "booked", "paid", "skipped"] as const;
export type OccurrenceStatus = (typeof OCCURRENCE_STATUSES)[number];

/** Lo que un PATCH manual puede pedir: nunca `booked` (eso lo decide el enlace). */
export const OCCURRENCE_PATCH_STATUSES = ["expected", "paid", "skipped"] as const;

export const MATCHED_KINDS = ["gl_check", "vendor_bill"] as const;
export type MatchedKind = (typeof MATCHED_KINDS)[number];

/**
 * Estado que ve la pantalla: `overdue` se deriva, nunca se guarda; `paid`
 * también se deriva de un `booked` cuyo documento ya está posted/pagado.
 */
export type OccurrenceViewStatus = OccurrenceStatus | "overdue";

const PAYEE_TYPES = ["vendor", "customer", "other", "other_name"] as const;
export type PayeeType = (typeof PAYEE_TYPES)[number];

/** Lo que define una regla; el mismo shape entra por POST/PATCH y sale por GET. */
export interface RecurringRuleInput {
  name: string;
  payee_type: PayeeType | null;
  payee_id: string | null;
  payee_name: string | null;
  expense_account_list_id: string | null;
  pay_from_account_list_id: string | null;
  expected_amount_cents: number;
  amount_kind: AmountKind;
  tolerance_cents: number;
  tolerance_pct: number;
  frequency: Frequency;
  day_of_month: number | null;
  weekday: number | null;
  month_of_year: number | null;
  end_of_month_policy: EndOfMonthPolicy;
  start_date: string; // YYYY-MM-DD (día de negocio ET)
  end_date: string | null;
  is_active: boolean;
  notes: string | null;
  document_kind: DocumentKind;
}

export interface RecurringRule extends RecurringRuleInput {
  id: string;
  created_by_user_id: string;
  updated_by_user_id: string;
  created_at: string;
  updated_at: string;
}

export interface RecurringOccurrence {
  id: string;
  rule_id: string;
  period_key: string;
  due_date: string;
  expected_amount_cents: number;
  tolerance_cents: number;
  tolerance_pct: number;
  status: OccurrenceStatus;
  actual_amount_cents: number | null;
  actual_date: string | null;
  matched_kind: MatchedKind | null;
  matched_id: string | null;
  note: string | null;
  /** Snapshot de lo que conduce el documento, congelado al materializar. */
  document_kind: DocumentKind | null;
  payee_type: PayeeType | null;
  payee_id: string | null;
  payee_name: string | null;
  expense_account_list_id: string | null;
  pay_from_account_list_id: string | null;
  /** Fecha movida a mano: la re-materialización no la toca. */
  due_date_override: boolean;
  updated_at: string;
}

/** Lo que la pantalla necesita del documento enlazado (resuelto al leer). */
export interface MatchedDocumentInfo {
  kind: MatchedKind;
  id: string;
  doc_number: string;
  status: string;
  /** Un check posted o un bill pagado: la ocurrencia se muestra `paid`. */
  settled: boolean;
  total_cents: number;
  href: string;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

export const ISO_DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

function optionalString(v: unknown, max: number): string | null {
  if (v == null) return null;
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

function isIntIn(v: unknown, lo: number, hi: number): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;
}

function oneOf<T extends string>(v: unknown, list: readonly T[]): v is T {
  return typeof v === "string" && (list as readonly string[]).includes(v);
}

/**
 * Valida el cuerpo de una regla. Falla con un mensaje concreto — nunca corrige
 * en silencio (un `day_of_month` 45 no se recorta a 31: se rechaza).
 */
export function parseRecurringRule(raw: unknown): ParseResult<RecurringRuleInput> {
  if (!raw || typeof raw !== "object") return { ok: false, error: "body must be an object" };
  const b = raw as Record<string, unknown>;

  const name = optionalString(b.name, 120);
  if (!name) return { ok: false, error: "name is required" };

  if (!oneOf(b.frequency, FREQUENCIES)) return { ok: false, error: "frequency is invalid" };
  const frequency = b.frequency;

  if (!isIntIn(b.expected_amount_cents, 1, Number.MAX_SAFE_INTEGER)) {
    return { ok: false, error: "expected_amount_cents must be a positive integer" };
  }
  const amount_kind = oneOf(b.amount_kind, AMOUNT_KINDS) ? b.amount_kind : "fixed";

  const tolerance_cents = b.tolerance_cents == null ? 0 : b.tolerance_cents;
  if (!isIntIn(tolerance_cents, 0, Number.MAX_SAFE_INTEGER)) {
    return { ok: false, error: "tolerance_cents must be a non-negative integer" };
  }
  const tolerance_pct = b.tolerance_pct == null ? 0 : b.tolerance_pct;
  if (typeof tolerance_pct !== "number" || !(tolerance_pct >= 0 && tolerance_pct <= 100)) {
    return { ok: false, error: "tolerance_pct must be between 0 and 100" };
  }

  if (typeof b.start_date !== "string" || !ISO_DATE_RE.test(b.start_date)) {
    return { ok: false, error: "start_date must be YYYY-MM-DD" };
  }
  const end_date = b.end_date == null || b.end_date === "" ? null : b.end_date;
  if (end_date !== null && (typeof end_date !== "string" || !ISO_DATE_RE.test(end_date))) {
    return { ok: false, error: "end_date must be YYYY-MM-DD" };
  }
  if (end_date !== null && end_date < b.start_date) {
    return { ok: false, error: "end_date must not precede start_date" };
  }

  const day_of_month = b.day_of_month == null ? null : b.day_of_month;
  const weekday = b.weekday == null ? null : b.weekday;
  const month_of_year = b.month_of_year == null ? null : b.month_of_year;

  if (frequency === "weekly" || frequency === "biweekly") {
    if (frequency === "weekly" && !isIntIn(weekday, 0, 6)) {
      return { ok: false, error: "weekday (0-6) is required for weekly rules" };
    }
  } else {
    if (!isIntIn(day_of_month, 1, 31)) {
      return { ok: false, error: "day_of_month (1-31) is required for monthly/quarterly/yearly rules" };
    }
    if (frequency === "yearly" && !isIntIn(month_of_year, 1, 12)) {
      return { ok: false, error: "month_of_year (1-12) is required for yearly rules" };
    }
  }

  const end_of_month_policy = oneOf(b.end_of_month_policy, EOM_POLICIES) ? b.end_of_month_policy : "last_day";

  const payee_type = oneOf(b.payee_type, PAYEE_TYPES) ? b.payee_type : null;
  const document_kind = oneOf(b.document_kind, DOCUMENT_KINDS) ? b.document_kind : "expense";
  if (document_kind === "bill" && payee_type !== "vendor") {
    return { ok: false, error: "a bill rule needs a vendor payee" };
  }

  return {
    ok: true,
    value: {
      name,
      payee_type,
      payee_id: payee_type ? optionalString(b.payee_id, 120) : null,
      payee_name: optionalString(b.payee_name, 200),
      expense_account_list_id: optionalString(b.expense_account_list_id, 120),
      pay_from_account_list_id: optionalString(b.pay_from_account_list_id, 120),
      expected_amount_cents: b.expected_amount_cents,
      amount_kind,
      tolerance_cents,
      tolerance_pct,
      frequency,
      day_of_month: isIntIn(day_of_month, 1, 31) ? day_of_month : null,
      weekday: isIntIn(weekday, 0, 6) ? weekday : null,
      month_of_year: isIntIn(month_of_year, 1, 12) ? month_of_year : null,
      end_of_month_policy,
      start_date: b.start_date,
      end_date,
      is_active: b.is_active === undefined ? true : b.is_active === true,
      notes: optionalString(b.notes, 1000),
      document_kind,
    },
  };
}

export interface OccurrencePatch {
  status: (typeof OCCURRENCE_PATCH_STATUSES)[number];
  actual_amount_cents: number | null;
  actual_date: string | null;
  note: string | null;
}

/** Mover UNA ocurrencia de día sin tocar la regla (`due_date_override`). */
export interface OccurrenceMove {
  due_date: string;
}

export function parseOccurrenceMove(raw: unknown): ParseResult<OccurrenceMove> {
  if (!raw || typeof raw !== "object") return { ok: false, error: "body must be an object" };
  const b = raw as Record<string, unknown>;
  if (typeof b.due_date !== "string" || !ISO_DATE_RE.test(b.due_date)) {
    return { ok: false, error: "due_date must be YYYY-MM-DD" };
  }
  return { ok: true, value: { due_date: b.due_date } };
}

/** PATCH de una ocurrencia: marcar pagada / saltada / volver a esperada. */
export function parseOccurrencePatch(raw: unknown): ParseResult<OccurrencePatch> {
  if (!raw || typeof raw !== "object") return { ok: false, error: "body must be an object" };
  const b = raw as Record<string, unknown>;
  if (!oneOf(b.status, OCCURRENCE_PATCH_STATUSES)) return { ok: false, error: "status is invalid" };
  const actual_amount_cents = b.actual_amount_cents == null ? null : b.actual_amount_cents;
  if (actual_amount_cents !== null && !isIntIn(actual_amount_cents, 0, Number.MAX_SAFE_INTEGER)) {
    return { ok: false, error: "actual_amount_cents must be a non-negative integer" };
  }
  const actual_date = b.actual_date == null || b.actual_date === "" ? null : b.actual_date;
  if (actual_date !== null && (typeof actual_date !== "string" || !ISO_DATE_RE.test(actual_date))) {
    return { ok: false, error: "actual_date must be YYYY-MM-DD" };
  }
  return {
    ok: true,
    value: {
      status: b.status,
      actual_amount_cents: b.status === "paid" ? actual_amount_cents : null,
      actual_date: b.status === "paid" ? actual_date : null,
      note: optionalString(b.note, 500),
    },
  };
}
