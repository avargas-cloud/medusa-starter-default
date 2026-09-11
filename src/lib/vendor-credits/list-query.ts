/**
 * Pure query builder for `GET /admin/vendor-credits` — no DB access, just
 * SQL text + `$n` bindings, so the WHERE/param-index arithmetic is testable
 * without a live connection. `applied_to` is a single `LEFT JOIN LATERAL`
 * aggregate (no N+1: one row trip regardless of how many credits/lines are
 * returned). `po_number` / `vendor_bill_number` come from two LEFT JOINs on
 * the snapshotted references (never written here).
 */
export interface ListVendorCreditsFilters {
  vendorId?: string;
  status?: string;
  /** Free-text search over number / vendor name / reason / memo / PO / bill number (ILIKE). */
  q?: string;
  limit: number;
  offset: number;
}

export interface BuiltQuery {
  sql: string;
  params: unknown[];
}

export function buildListVendorCreditsQuery(filters: ListVendorCreditsFilters): BuiltQuery {
  const clauses: string[] = ["vc.deleted_at IS NULL"];
  const params: unknown[] = [];

  if (filters.vendorId) {
    params.push(filters.vendorId);
    clauses.push(`vc.vendor_id = $${params.length}`);
  }
  if (filters.status) {
    params.push(filters.status);
    clauses.push(`vc.status = $${params.length}`);
  }
  if (filters.q) {
    params.push(`%${filters.q}%`);
    const idx = params.length;
    clauses.push(
      `(vc.number ILIKE $${idx} OR vc.vendor_name_snapshot ILIKE $${idx} OR vc.reason ILIKE $${idx} OR vc.memo ILIKE $${idx} OR po.number ILIKE $${idx} OR vb.number ILIKE $${idx})`
    );
  }

  params.push(filters.limit, filters.offset);
  const limitIdx = params.length - 1;
  const offsetIdx = params.length;

  const sql = `
    SELECT vc.id, vc.number, vc.vendor_id, vc.vendor_name_snapshot, vc.credit_date, vc.reason, vc.memo,
           vc.status, vc.total_cents, vc.applied_cents, vc.qb_txn_id, vc.posted_at, vc.voided_at, vc.created_at,
           vc.purchase_order_id, po.number AS po_number,
           vc.vendor_bill_id, vb.number AS vendor_bill_number,
           COALESCE(applied.applied_to, '[]'::json) AS applied_to
      FROM vendor_credit vc
      LEFT JOIN purchase_order po ON po.id = vc.purchase_order_id AND po.deleted_at IS NULL
      LEFT JOIN vendor_bill vb ON vb.id = vc.vendor_bill_id AND vb.deleted_at IS NULL
      LEFT JOIN LATERAL (
        SELECT json_agg(
                 json_build_object(
                   'vendor_bill_id', ca.vendor_bill_id,
                   'bill_number', avb.number,
                   'amount_cents', ca.amount_cents
                 ) ORDER BY ca.applied_at DESC
               ) AS applied_to
          FROM vendor_credit_application ca
          JOIN vendor_bill avb ON avb.id = ca.vendor_bill_id
         WHERE ca.credit_id = vc.id AND ca.voided_at IS NULL
      ) applied ON true
     WHERE ${clauses.join(" AND ")}
     ORDER BY vc.created_at DESC
     LIMIT $${limitIdx} OFFSET $${offsetIdx}
  `;

  return { sql, params };
}
