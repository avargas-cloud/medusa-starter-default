/**
 * gl-purchases-v2 §3 — Vendor Credits. Shared types for
 * `src/lib/vendor-credits/**`. Every write goes through a `PgClient`
 * ($1 bindings, `pg.Client|PoolClient`) — never knex `?`.
 */

export type PgClient = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number | null }>;
};

export type VendorCreditStatus = "draft" | "posted" | "voided";
export type VendorCreditLineType = "product" | "qb_account";

export interface VendorCreditLineInput {
  line_type: VendorCreditLineType;
  variant_id?: string | null;
  sku?: string | null;
  // Product lines only. When omitted, insert time defaults it from
  // `product_variant.metadata->>'mpn'` (same source vendor_bill_line uses).
  mpn?: string | null;
  description?: string | null;
  qty?: number | null;
  unit_cost_cents?: number | null;
  qb_account_list_id?: string | null;
  amount_cents: number;
}

export interface CreateVendorCreditInput {
  vendor_id: string;
  credit_date: string; // YYYY-MM-DD
  reason?: string | null;
  memo?: string | null;
  lines: VendorCreditLineInput[];
  actor_id: string;
}

export class VendorCreditError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "VendorCreditError";
    this.code = code;
    this.status = status;
  }
}
