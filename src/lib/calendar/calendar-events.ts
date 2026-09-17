/**
 * src/lib/calendar/calendar-events.ts
 *
 * El contrato de evento que comparten los dos calendarios del POS (el personal
 * sobre Google y el de Accounting). Cada fuente se proyecta a esta forma y la
 * vista no sabe de dónde vino; `source` sólo decide color y qué panel abre.
 *
 * `start`/`end` son `YYYY-MM-DD` cuando `all_day` (un vencimiento no tiene
 * hora) o ISO-8601 con zona cuando no.
 */
import { payrollHalves, fetchPayrollRows } from "../../api/admin/reports/_lib/monthly-payroll";
import { getBusinessDateString } from "../date/et";

import { viewStatus } from "./recurring-occurrences";
import type { RawPg } from "./recurring-repo";
import type { OccurrenceViewStatus, RecurringOccurrence, RecurringRule } from "./recurring-types";

export type CalendarSource = "google_personal" | "recurring_expense" | "payroll";

export type AttendeeStatus = "needsAction" | "accepted" | "declined" | "tentative";

export interface CalendarAttendee {
  email: string;
  name: string | null;
  status: AttendeeStatus | null;
  /** El dueño del calendario, cuando Google lo lista entre los asistentes. */
  self: boolean;
}

export interface CalendarEvent {
  id: string;
  source: CalendarSource;
  title: string;
  start: string;
  end: string | null;
  all_day: boolean;
  status: OccurrenceViewStatus | null;
  amount_cents: number | null;
  /** Referencia a la fila de origen (id de ocurrencia, mes de nómina, eventId de Google). */
  ref: string;
  meta: Record<string, string | number | boolean | null>;
  /** Sólo eventos de Google; los del calendario contable no tienen invitados. */
  attendees?: CalendarAttendee[];
}

export function occurrenceToEvent(
  occ: RecurringOccurrence,
  rule: Pick<RecurringRule, "name" | "payee_name" | "amount_kind" | "expense_account_list_id" | "pay_from_account_list_id">,
  todayEt: string
): CalendarEvent {
  return {
    id: `rexo:${occ.id}`,
    source: "recurring_expense",
    title: rule.name,
    start: occ.due_date,
    end: null,
    all_day: true,
    status: viewStatus(occ.status, occ.due_date, todayEt),
    amount_cents: occ.status === "paid" && occ.actual_amount_cents != null ? occ.actual_amount_cents : occ.expected_amount_cents,
    ref: occ.id,
    meta: {
      rule_id: occ.rule_id,
      payee_name: rule.payee_name,
      amount_kind: rule.amount_kind,
      expected_amount_cents: occ.expected_amount_cents,
      expense_account_list_id: rule.expense_account_list_id,
      pay_from_account_list_id: rule.pay_from_account_list_id,
      note: occ.note,
    },
  };
}

/**
 * Nómina proyectada desde `pos_monthly_payroll` (sólo lectura): dos hitos por
 * mes cargado (15 y 30/último), mitad cada uno, igual que la reconoce el P&L.
 * Un mes del rango SIN fila también aparece — en cero y marcado — para que el
 * contador vea que falta cargarlo.
 */
export async function payrollEvents(pg: RawPg, from: string, to: string, todayEt: string): Promise<CalendarEvent[]> {
  const rows = await fetchPayrollRows(pg);
  const byMonth = new Map(rows.map((r) => [r.month, r.amount_cents]));
  const out: CalendarEvent[] = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  const endKey = to.slice(0, 7);
  for (;;) {
    const month = `${y}-${String(m).padStart(2, "0")}`;
    if (month > endKey) break;
    const cents = byMonth.get(month) ?? 0;
    payrollHalves(month, cents).forEach((half, idx) => {
      const day = getBusinessDateString(half.at);
      if (day >= from && day <= to) {
        out.push({
          id: `payroll:${month}:${idx + 1}`,
          source: "payroll",
          title: cents > 0 ? `Payroll (${idx === 0 ? "1st" : "2nd"} half)` : "Payroll — amount not entered",
          start: day,
          end: null,
          all_day: true,
          // Nunca "paid" por haber pasado la fecha: la nómina es una proyección
          // informativa; `recognized` dice si el P&L ya la reconoce.
          status: null,
          amount_cents: cents > 0 ? half.cents : null,
          ref: month,
          meta: { month, entered: cents > 0, recognized: cents > 0 && day < todayEt },
        });
      }
    });
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}
