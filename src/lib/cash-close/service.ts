/**
 * Cash Close — service layer. `computeCashClose` is read-only; `createCashClose`
 * is the only writer, and it writes exactly once, inside one transaction:
 * recompute → refuse if unbalanced → allocate the number → insert → supersede
 * whatever else was on file for that day. `holdPayment` is the only writer of
 * `customer_payment.metadata.cash_close_hold` — the HTTP route and the
 * sandbox E2E both call it, never re-implement the SQL.
 */
import { randomUUID } from "node:crypto";

import { computeSnapshot, type CashCloseDayRows } from "./totals";
import { getBusinessDateString } from "../date/et";
import {
  loadCreditMemosForDay,
  loadExistingClosesForDay,
  loadInvoicesForDay,
  loadOrderEstimateAgg,
  loadPaymentsForDay,
  loadRefundsForDay,
  type Knexish,
  type StoredCashClose,
} from "./load-day";
import type {
  CashCloseHold,
  CashCloseRecord,
  CashCloseSnapshot,
  HoldKind,
} from "./types";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A tiny factory for "named error, one string detail" classes — five of
 * these live in this file and don't need five hand-written bodies. */
function detailError(name: string) {
  return class extends Error {
    constructor(public readonly detail: string) {
      super(`${name}: ${detail}`);
      this.name = name;
    }
  };
}

export const CashCloseInvalidDayError = detailError("CASH_CLOSE_INVALID_DAY");
export const CashClosePaymentNotFoundError = detailError("CASH_CLOSE_PAYMENT_NOT_FOUND");
export const CashClosePaymentVoidedError = detailError("CASH_CLOSE_PAYMENT_VOIDED");
export const CashClosePaymentFullyAppliedError = detailError("CASH_CLOSE_PAYMENT_FULLY_APPLIED");

export class CashCloseNotBalancedError extends Error {
  constructor(
    public readonly unexplained_cents: number,
    public readonly unexplained_count: number
  ) {
    super(`CASH_CLOSE_NOT_BALANCED: unexplained ${unexplained_cents} cents across ${unexplained_count} payment(s)`);
    this.name = "CashCloseNotBalancedError";
  }
}

export const CashCloseDayNotClosedError = detailError("CASH_CLOSE_DAY_NOT_CLOSED");

/** Latest closable day: yesterday in ET. Today is still taking payments. */
export function latestClosableDay(now: Date = new Date()): string {
  return getBusinessDateString(new Date(now.getTime() - 24 * 60 * 60 * 1000));
}

export function assertValidDay(day: unknown): asserts day is string {
  if (typeof day !== "string" || !DAY_RE.test(day)) {
    throw new CashCloseInvalidDayError(String(day));
  }
  if (day > latestClosableDay()) {
    throw new CashCloseDayNotClosedError(day);
  }
}

async function loadDayRows(knex: Knexish, day: string): Promise<CashCloseDayRows> {
  const [payments, invoices, creditMemos, refunds, orderEstimateAgg] = await Promise.all([
    loadPaymentsForDay(knex, day),
    loadInvoicesForDay(knex, day),
    loadCreditMemosForDay(knex, day),
    loadRefundsForDay(knex, day),
    loadOrderEstimateAgg(knex, day),
  ]);
  return { payments, invoices, creditMemos, refunds, orderEstimateAgg };
}

export async function computeCashClose(knex: Knexish, day: string): Promise<CashCloseSnapshot> {
  assertValidDay(day);
  const dayRows = await loadDayRows(knex, day);
  return computeSnapshot(dayRows, day, new Date());
}

/** email, or first+last, from `"user"` — null (never a blank string) for an
 * actor the table doesn't know, so callers can decide their own fallback. */
export async function resolveUserName(knex: Knexish, actorId: string): Promise<string | null> {
  const { rows } = await knex.raw<{ email: string | null; first_name: string | null; last_name: string | null }>(
    `SELECT email, first_name, last_name FROM "user" WHERE id = ? AND deleted_at IS NULL`,
    [actorId]
  );
  const u = rows[0];
  if (!u) return null;
  const full = [u.first_name, u.last_name].filter(Boolean).join(" ").trim();
  return full || u.email || null;
}

const COUNTER_NAME = "cash_close";

export async function createCashClose(
  knex: Knexish,
  params: { day: string; actorId: string }
): Promise<CashCloseRecord> {
  assertValidDay(params.day);
  return knex.transaction(async (trx) => {
    const dayRows = await loadDayRows(trx, params.day);
    const snapshot = computeSnapshot(dayRows, params.day, new Date());
    if (!snapshot.balanced) {
      throw new CashCloseNotBalancedError(snapshot.totals.unexplained_cents, snapshot.totals.unexplained_count);
    }

    const counterRows = await trx.raw<{ value: string | number }>(
      `UPDATE document_number_counter SET value = value + 1, updated_at = now()
        WHERE name = ? RETURNING value`,
      [COUNTER_NAME]
    );
    const counterValue = counterRows.rows[0];
    if (!counterValue) {
      throw new Error(`[cash-close] counter '${COUNTER_NAME}' is missing — run the Cash Close migration first`);
    }
    const number = `CC-${String(Number(counterValue.value)).padStart(4, "0")}`;

    const createdByName = await resolveUserName(trx, params.actorId);
    const id = `cc_${randomUUID().replace(/-/g, "")}`;
    const createdAt = new Date();

    await trx.raw(
      `INSERT INTO pos_cash_close
          (id, number, business_day, balanced, snapshot, totals, created_by, created_by_name, created_at)
        VALUES (?, ?, ?, true, ?::jsonb, ?::jsonb, ?, ?, ?)`,
      [id, number, params.day, JSON.stringify(snapshot), JSON.stringify(snapshot.totals),
        params.actorId, createdByName, createdAt.toISOString()]
    );

    // Supersede whatever else was on file for this day — one live close at
    // a time, older ones stay in history via `superseded_by`.
    await trx.raw(
      `UPDATE pos_cash_close SET superseded_by = ?
        WHERE business_day = ? AND id <> ? AND superseded_by IS NULL`,
      [id, params.day, id]
    );

    return {
      id, number, business_day: params.day, balanced: true,
      created_by: params.actorId, created_by_name: createdByName,
      created_at: createdAt.toISOString(), snapshot,
    };
  });
}

function toRecord(row: StoredCashClose): CashCloseRecord {
  return {
    id: row.id, number: row.number, business_day: row.business_day, balanced: true,
    created_by: row.created_by, created_by_name: row.created_by_name,
    created_at: row.created_at, snapshot: row.snapshot as CashCloseSnapshot,
  };
}

export async function getCashClose(knex: Knexish, id: string): Promise<CashCloseRecord | null> {
  const { rows } = await knex.raw<StoredCashClose>(
    `SELECT id, number, business_day::text AS business_day, balanced, snapshot, totals,
            created_by, created_by_name, created_at, superseded_by
       FROM pos_cash_close WHERE id = ?`,
    [id]
  );
  const row = rows[0];
  return row ? toRecord(row) : null;
}

export interface CashCloseListItem {
  id: string;
  number: string;
  business_day: string;
  balanced: boolean;
  totals: CashCloseRecord["snapshot"]["totals"];
  created_by: string;
  created_by_name: string | null;
  created_at: string;
  superseded_by: string | null;
}

export async function listCashCloses(
  knex: Knexish,
  params: { from?: string; to?: string; limit?: number }
): Promise<CashCloseListItem[]> {
  const conditions: string[] = [];
  const values: unknown[] = [];
  if (params.from) { conditions.push("business_day >= ?"); values.push(params.from); }
  if (params.to) { conditions.push("business_day <= ?"); values.push(params.to); }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = Math.min(Math.max(params.limit ?? 100, 1), 500);
  values.push(limit);

  const { rows } = await knex.raw<CashCloseListItem>(
    `SELECT id, number, business_day::text AS business_day, balanced, totals,
            created_by, created_by_name, created_at, superseded_by
       FROM pos_cash_close ${where}
      ORDER BY created_at DESC LIMIT ?`,
    values
  );
  return rows;
}

export async function getExistingClosesForDay(knex: Knexish, day: string): Promise<StoredCashClose[]> {
  return loadExistingClosesForDay(knex, day);
}

// ── Hold ─────────────────────────────────────────────────────────────────

interface PaymentBalanceRow {
  id: string;
  status: string;
  amount: string;
  applied: string;
}

export async function holdPayment(
  knex: Knexish,
  params: { paymentId: string; kind: HoldKind | null; note: string | null; actorId: string }
): Promise<CashCloseHold | null> {
  const { rows } = await knex.raw<PaymentBalanceRow>(
    `SELECT cp.id, cp.status, cp.amount::text AS amount,
            COALESCE((SELECT sum(pa.amount_applied) FROM payment_application pa
                       WHERE pa.payment_id = cp.id AND pa.voided_at IS NULL AND pa.deleted_at IS NULL), 0)::text AS applied
       FROM customer_payment cp WHERE cp.id = ? AND cp.deleted_at IS NULL`,
    [params.paymentId]
  );
  const payment = rows[0];
  if (!payment) throw new CashClosePaymentNotFoundError(params.paymentId);
  if (payment.status === "voided") throw new CashClosePaymentVoidedError(params.paymentId);
  const unapplied = Number(payment.amount) - Number(payment.applied);
  if (!(unapplied > 0)) throw new CashClosePaymentFullyAppliedError(params.paymentId);

  const byName = await resolveUserName(knex, params.actorId);

  if (!params.kind) {
    await knex.raw(
      `UPDATE customer_payment SET metadata = COALESCE(metadata, '{}'::jsonb)
                          || jsonb_build_object('cash_close_hold', 'null'::jsonb) WHERE id = ?`,
      [params.paymentId]
    );
    return null;
  }

  const hold: CashCloseHold = {
    kind: params.kind, note: params.note, by: params.actorId,
    by_name: byName, at: new Date().toISOString(),
  };
  await knex.raw(
    `UPDATE customer_payment SET metadata = COALESCE(metadata, '{}'::jsonb)
                        || jsonb_build_object('cash_close_hold', ?::jsonb) WHERE id = ?`,
    [JSON.stringify(hold), params.paymentId]
  );
  return hold;
}
