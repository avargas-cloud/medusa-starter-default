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
import { getDbPool } from "../../api/utils/db-pool";
import { getBusinessDateString } from "../date/et";
import { computeBillBalancesBatch } from "../finance/recompute-bill-finance";

import { viewStatus } from "./recurring-occurrences";
import type { RawPg } from "./recurring-repo";
import type { MatchedDocumentInfo, OccurrenceViewStatus, RecurringOccurrence, RecurringRule } from "./recurring-types";

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

/**
 * Los documentos enlazados de un lote de ocurrencias, resueltos al leer: el
 * calendario no guarda si un check se posteó o un bill se pagó — lo mira.
 * Un documento borrado (bill draft eliminado) simplemente no aparece.
 */
export async function resolveMatchedDocuments(
  occurrences: RecurringOccurrence[]
): Promise<Map<string, MatchedDocumentInfo>> {
  const out = new Map<string, MatchedDocumentInfo>();
  const checkIds = occurrences.filter((o) => o.matched_kind === "gl_check").map((o) => o.matched_id as string);
  const billIds = occurrences.filter((o) => o.matched_kind === "vendor_bill").map((o) => o.matched_id as string);
  const pool = getDbPool();
  if (checkIds.length) {
    const res = await pool.query<{ id: string; doc_number: string; status: string; total_cents: string }>(
      `SELECT id, doc_number, status, total_cents::text FROM gl_check WHERE id = ANY($1::text[]) AND deleted_at IS NULL`,
      [checkIds]
    );
    for (const r of res.rows) {
      out.set(`gl_check:${r.id}`, {
        kind: "gl_check",
        id: r.id,
        doc_number: r.doc_number,
        status: r.status,
        settled: r.status === "posted",
        total_cents: Number(r.total_cents),
        href: `/accounting/checks?check=${encodeURIComponent(r.id)}`,
      });
    }
  }
  if (billIds.length) {
    const res = await pool.query<{ id: string; number: string | null; status: string }>(
      `SELECT id, number, status FROM vendor_bill WHERE id = ANY($1::text[]) AND deleted_at IS NULL`,
      [billIds]
    );
    const balances = await computeBillBalancesBatch(pool, res.rows.map((r) => r.id));
    for (const r of res.rows) {
      const b = balances.get(r.id);
      out.set(`vendor_bill:${r.id}`, {
        kind: "vendor_bill",
        id: r.id,
        doc_number: r.number ?? r.id,
        status: r.status,
        settled: r.status !== "cancelled" && b?.paid_status === "paid",
        total_cents: b?.payable_cents ?? 0,
        href: `/vendor-bills/${encodeURIComponent(r.id)}`,
      });
    }
  }
  return out;
}

export function matchedDocumentOf(
  occ: RecurringOccurrence,
  docs: ReadonlyMap<string, MatchedDocumentInfo>
): MatchedDocumentInfo | null {
  return occ.matched_kind && occ.matched_id ? (docs.get(`${occ.matched_kind}:${occ.matched_id}`) ?? null) : null;
}

export function occurrenceToEvent(
  occ: RecurringOccurrence,
  rule: Pick<RecurringRule, "name" | "amount_kind">,
  todayEt: string,
  doc: MatchedDocumentInfo | null = null
): CalendarEvent {
  const status = viewStatus(occ.status, occ.due_date, todayEt, doc?.settled ?? false);
  return {
    id: `rexo:${occ.id}`,
    source: "recurring_expense",
    title: rule.name,
    start: occ.due_date,
    end: null,
    all_day: true,
    status,
    amount_cents:
      (occ.status === "paid" || occ.status === "booked") && occ.actual_amount_cents != null
        ? occ.actual_amount_cents
        : occ.expected_amount_cents,
    ref: occ.id,
    meta: {
      rule_id: occ.rule_id,
      payee_name: occ.payee_name,
      amount_kind: rule.amount_kind,
      expected_amount_cents: occ.expected_amount_cents,
      expense_account_list_id: occ.expense_account_list_id,
      pay_from_account_list_id: occ.pay_from_account_list_id,
      document_kind: occ.document_kind,
      due_date_override: occ.due_date_override,
      note: occ.note,
      matched_kind: occ.matched_kind,
      matched_id: occ.matched_id,
      matched_doc_number: doc?.doc_number ?? null,
      matched_status: doc?.status ?? null,
      matched_href: doc?.href ?? null,
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
