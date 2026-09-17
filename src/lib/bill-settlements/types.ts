/**
 * pay-bills-credits-prepayments-20260917 — shared types for
 * `src/lib/bill-settlements/**`. Every write goes through a `PgClient`
 * ($1 bindings, `pg.Client|PoolClient`) — never knex `?`.
 */

import type { BillPaymentMethod } from "../bill-payments/types";

export type PgClient = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number | null }>;
};

export interface CreditAllocationInput {
  credit_id: string;
  vendor_bill_id: string;
  amount_cents: number;
}

export interface PrepaymentAllocationInput {
  gl_check_line_id: string;
  vendor_bill_id: string;
  amount_cents: number;
}

export interface CashPaymentInput {
  bank_account_list_id: string;
  method: BillPaymentMethod;
  reference?: string | null;
  memo?: string | null;
  allocations: Array<{ vendor_bill_id: string; amount_cents: number }>;
}

export interface SettleBillsInput {
  vendor_id: string;
  settlement_date: string; // YYYY-MM-DD
  credit_allocations: CreditAllocationInput[];
  prepayment_allocations: PrepaymentAllocationInput[];
  cash?: CashPaymentInput | null;
  actor_id: string;
}

export type SettlementStep =
  | { kind: "credit"; credit_id: string; vendor_bill_id: string; amount_cents: number; application_id: string; qb: unknown }
  | {
      kind: "prepayment";
      gl_check_line_id: string;
      vendor_bill_id: string;
      amount_cents: number;
      vendor_credit_id: string;
      vendor_credit_number: string;
      application_id: string;
      qb_add: unknown;
      qb_apply: unknown;
    }
  | { kind: "cash"; bill_payment_id: string; number: string; amount_cents: number; qb: unknown };

export interface SettleBillsResult {
  ok: boolean;
  steps: SettlementStep[];
  failed?: { kind: "credit" | "prepayment" | "cash"; code: string; message: string; status: number };
}

export class BillSettlementError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "BillSettlementError";
    this.code = code;
    this.status = status;
  }
}
