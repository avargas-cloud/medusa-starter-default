/**
 * src/lib/calendar/recurring-repo.ts
 *
 * SQL del calendario de gastos recurrentes. Bindings knex `?`
 * (`__pg_connection__`), el mismo handle que usa `guardSupervisorPin`.
 *
 * Materializar es idempotente por `uq_rexo_rule_period` (ON CONFLICT DO
 * NOTHING). Al EDITAR una regla se re-materializa sólo el futuro no resuelto:
 * las ocurrencias `expected` con fecha >= hoy se borran y regeneran con el
 * snapshot nuevo; las pagadas/saltadas/enlazadas, las pasadas y las MOVIDAS a
 * mano (`due_date_override`) quedan como estaban — snapshot íntegro incluido.
 *
 * El snapshot de la ocurrencia congela también lo que conduce el documento
 * (kind, payee, cuentas): editar la regla nunca reescribe un prefill pasado.
 */
import { randomUUID } from "crypto";

import { addDays } from "./recurring-occurrences";
import { generateOccurrences } from "./recurring-occurrences";
import type {
  RecurringOccurrence,
  RecurringRule,
  RecurringRuleInput,
} from "./recurring-types";

export type RawPg = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
};

/** Días hacia adelante que se materializan (el job corre a diario). */
export const MATERIALIZE_HORIZON_DAYS = 90;

const iso = (v: unknown): string =>
  v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
const ts = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const optStr = (v: unknown): string | null => (v == null ? null : String(v));
const optInt = (v: unknown): number | null => (v == null ? null : Number(v));

function rowToRule(r: Record<string, unknown>): RecurringRule {
  return {
    id: String(r.id),
    name: String(r.name),
    payee_type: optStr(r.payee_type) as RecurringRule["payee_type"],
    payee_id: optStr(r.payee_id),
    payee_name: optStr(r.payee_name),
    expense_account_list_id: optStr(r.expense_account_list_id),
    pay_from_account_list_id: optStr(r.pay_from_account_list_id),
    expected_amount_cents: Number(r.expected_amount_cents),
    amount_kind: String(r.amount_kind) as RecurringRule["amount_kind"],
    tolerance_cents: Number(r.tolerance_cents),
    tolerance_pct: Number(r.tolerance_pct),
    frequency: String(r.frequency) as RecurringRule["frequency"],
    day_of_month: optInt(r.day_of_month),
    weekday: optInt(r.weekday),
    month_of_year: optInt(r.month_of_year),
    end_of_month_policy: String(r.end_of_month_policy) as RecurringRule["end_of_month_policy"],
    start_date: iso(r.start_date),
    end_date: r.end_date == null ? null : iso(r.end_date),
    is_active: r.is_active === true,
    notes: optStr(r.notes),
    document_kind: String(r.document_kind ?? "expense") as RecurringRule["document_kind"],
    created_by_user_id: String(r.created_by_user_id),
    updated_by_user_id: String(r.updated_by_user_id),
    created_at: ts(r.created_at),
    updated_at: ts(r.updated_at),
  };
}

export function rowToOccurrence(r: Record<string, unknown>): RecurringOccurrence {
  return {
    id: String(r.id),
    rule_id: String(r.rule_id),
    period_key: String(r.period_key),
    due_date: iso(r.due_date),
    expected_amount_cents: Number(r.expected_amount_cents),
    tolerance_cents: Number(r.tolerance_cents),
    tolerance_pct: Number(r.tolerance_pct),
    status: String(r.status) as RecurringOccurrence["status"],
    actual_amount_cents: optInt(r.actual_amount_cents),
    actual_date: r.actual_date == null ? null : iso(r.actual_date),
    matched_kind: optStr(r.matched_kind) as RecurringOccurrence["matched_kind"],
    matched_id: optStr(r.matched_id),
    note: optStr(r.note),
    document_kind: optStr(r.document_kind) as RecurringOccurrence["document_kind"],
    payee_type: optStr(r.payee_type) as RecurringOccurrence["payee_type"],
    payee_id: optStr(r.payee_id),
    payee_name: optStr(r.payee_name),
    expense_account_list_id: optStr(r.expense_account_list_id),
    pay_from_account_list_id: optStr(r.pay_from_account_list_id),
    due_date_override: r.due_date_override === true,
    updated_at: ts(r.updated_at),
  };
}

export const OCCURRENCE_COLS = `id, rule_id, period_key, due_date, expected_amount_cents, tolerance_cents,
  tolerance_pct, status, actual_amount_cents, actual_date, matched_kind, matched_id, note,
  document_kind, payee_type, payee_id, payee_name, expense_account_list_id, pay_from_account_list_id,
  due_date_override, updated_at`;

const RULE_COLS = `id, name, payee_type, payee_id, payee_name, expense_account_list_id,
  pay_from_account_list_id, expected_amount_cents, amount_kind, tolerance_cents, tolerance_pct,
  frequency, day_of_month, weekday, month_of_year, end_of_month_policy, start_date, end_date,
  is_active, notes, document_kind, created_by_user_id, updated_by_user_id, created_at, updated_at`;

export async function listRules(pg: RawPg, includeInactive = true): Promise<RecurringRule[]> {
  const res = await pg.raw(
    `SELECT ${RULE_COLS} FROM recurring_expense_rule
      WHERE (? OR is_active) ORDER BY is_active DESC, name`,
    [includeInactive]
  );
  return res.rows.map(rowToRule);
}

export async function getRule(pg: RawPg, id: string): Promise<RecurringRule | null> {
  const res = await pg.raw(`SELECT ${RULE_COLS} FROM recurring_expense_rule WHERE id = ?`, [id]);
  return res.rows[0] ? rowToRule(res.rows[0]) : null;
}

function ruleValues(input: RecurringRuleInput): unknown[] {
  return [
    input.name,
    input.payee_type,
    input.payee_id,
    input.payee_name,
    input.expense_account_list_id,
    input.pay_from_account_list_id,
    input.expected_amount_cents,
    input.amount_kind,
    input.tolerance_cents,
    input.tolerance_pct,
    input.frequency,
    input.day_of_month,
    input.weekday,
    input.month_of_year,
    input.end_of_month_policy,
    input.start_date,
    input.end_date,
    input.is_active,
    input.notes,
    input.document_kind,
  ];
}

export async function createRule(pg: RawPg, input: RecurringRuleInput, actorId: string): Promise<RecurringRule> {
  const id = `rex_${randomUUID()}`;
  await pg.raw(
    `INSERT INTO recurring_expense_rule (id, name, payee_type, payee_id, payee_name,
       expense_account_list_id, pay_from_account_list_id, expected_amount_cents, amount_kind,
       tolerance_cents, tolerance_pct, frequency, day_of_month, weekday, month_of_year,
       end_of_month_policy, start_date, end_date, is_active, notes, document_kind, created_by_user_id, updated_by_user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, ...ruleValues(input), actorId, actorId]
  );
  const rule = await getRule(pg, id);
  if (!rule) throw new Error("rule vanished after insert");
  return rule;
}

export async function updateRule(
  pg: RawPg,
  id: string,
  input: RecurringRuleInput,
  actorId: string
): Promise<RecurringRule | null> {
  await pg.raw(
    `UPDATE recurring_expense_rule SET
       name = ?, payee_type = ?, payee_id = ?, payee_name = ?, expense_account_list_id = ?,
       pay_from_account_list_id = ?, expected_amount_cents = ?, amount_kind = ?, tolerance_cents = ?,
       tolerance_pct = ?, frequency = ?, day_of_month = ?, weekday = ?, month_of_year = ?,
       end_of_month_policy = ?, start_date = ?, end_date = ?, is_active = ?, notes = ?,
       document_kind = ?, updated_by_user_id = ?, updated_at = now()
     WHERE id = ?`,
    [...ruleValues(input), actorId, id]
  );
  return getRule(pg, id);
}

export async function deleteRule(pg: RawPg, id: string): Promise<boolean> {
  const res = await pg.raw(`DELETE FROM recurring_expense_rule WHERE id = ? RETURNING id`, [id]);
  return res.rows.length > 0;
}

/**
 * Inserta los vencimientos que falten en [from, to]. Devuelve cuántos entró.
 * Una regla inactiva no materializa; sus ocurrencias ya creadas se conservan.
 */
export async function materializeRule(pg: RawPg, rule: RecurringRule, from: string, to: string): Promise<number> {
  if (!rule.is_active) return 0;
  let inserted = 0;
  for (const occ of generateOccurrences(rule, from, to)) {
    const res = await pg.raw(
      `INSERT INTO recurring_expense_occurrence
         (id, rule_id, period_key, due_date, expected_amount_cents, tolerance_cents, tolerance_pct,
          document_kind, payee_type, payee_id, payee_name, expense_account_list_id, pay_from_account_list_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (rule_id, period_key) DO NOTHING
       RETURNING id`,
      [
        `rexo_${randomUUID()}`, rule.id, occ.period_key, occ.due_date,
        rule.expected_amount_cents, rule.tolerance_cents, rule.tolerance_pct,
        rule.document_kind, rule.payee_type, rule.payee_id, rule.payee_name,
        rule.expense_account_list_id, rule.pay_from_account_list_id,
      ]
    );
    inserted += res.rows.length;
  }
  return inserted;
}

/**
 * Borra el futuro no resuelto de una regla y lo regenera con el snapshot
 * vigente. Una ocurrencia movida a mano (`due_date_override`) se conserva
 * entera: su `period_key` sigue ocupado, así el ON CONFLICT no la duplica.
 */
export async function rematerializeFuture(pg: RawPg, rule: RecurringRule, todayEt: string): Promise<number> {
  await pg.raw(
    `DELETE FROM recurring_expense_occurrence
      WHERE rule_id = ? AND status = 'expected' AND due_date >= ? AND NOT due_date_override`,
    [rule.id, todayEt]
  );
  return materializeRule(pg, rule, todayEt, addDays(todayEt, MATERIALIZE_HORIZON_DAYS));
}

export async function materializeAll(pg: RawPg, todayEt: string): Promise<{ rules: number; inserted: number }> {
  const rules = await listRules(pg, false);
  let inserted = 0;
  const to = addDays(todayEt, MATERIALIZE_HORIZON_DAYS);
  // Desde el 1° del mes corriente: un vencimiento de hace tres semanas que
  // nadie marcó tiene que aparecer como overdue, no desaparecer.
  const from = `${todayEt.slice(0, 7)}-01`;
  for (const rule of rules) inserted += await materializeRule(pg, rule, from, to);
  return { rules: rules.length, inserted };
}

export async function listOccurrences(pg: RawPg, from: string, to: string): Promise<RecurringOccurrence[]> {
  const res = await pg.raw(
    `SELECT ${OCCURRENCE_COLS} FROM recurring_expense_occurrence
      WHERE due_date BETWEEN ? AND ?
      ORDER BY due_date, id`,
    [from, to]
  );
  return res.rows.map(rowToOccurrence);
}

export async function getOccurrence(pg: RawPg, id: string): Promise<RecurringOccurrence | null> {
  const res = await pg.raw(`SELECT ${OCCURRENCE_COLS} FROM recurring_expense_occurrence WHERE id = ?`, [id]);
  return res.rows[0] ? rowToOccurrence(res.rows[0]) : null;
}

/** La ocurrencia que un documento liquidó (para el backlink documento → calendario). */
export async function findOccurrenceByDocument(
  pg: RawPg,
  matchedKind: string,
  matchedId: string
): Promise<RecurringOccurrence | null> {
  const res = await pg.raw(
    `SELECT ${OCCURRENCE_COLS} FROM recurring_expense_occurrence WHERE matched_kind = ? AND matched_id = ?`,
    [matchedKind, matchedId]
  );
  return res.rows[0] ? rowToOccurrence(res.rows[0]) : null;
}
