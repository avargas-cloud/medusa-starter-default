/**
 * gl-purchases-v2 §3 — Pay Bills. Shared types for `src/lib/bill-payments/**`.
 * Every write goes through a `PgClient` ($1 bindings, `pg.Client|PoolClient`).
 */

export type PgClient = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number | null }>;
};

export type BillPaymentStatus = "posted" | "voided";
export type BillPaymentMethod = "check" | "ach" | "wire" | "card" | "cash";

export const BILL_PAYMENT_METHODS: BillPaymentMethod[] = [
  "check",
  "ach",
  "wire",
  "card",
  "cash",
];

export interface BillPaymentAllocationInput {
  vendor_bill_id: string;
  amount_cents: number;
  credit_application_id?: string | null;
}

export interface CreateBillPaymentInput {
  vendor_id: string;
  bank_account_list_id: string;
  payment_date: string; // YYYY-MM-DD
  method: BillPaymentMethod;
  reference?: string | null;
  memo?: string | null;
  allocations: BillPaymentAllocationInput[];
  actor_id: string;
}

export class BillPaymentError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "BillPaymentError";
    this.code = code;
    this.status = status;
  }
}
