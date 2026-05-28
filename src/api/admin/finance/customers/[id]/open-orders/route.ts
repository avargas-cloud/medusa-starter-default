import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { getDbPool } from "../../../../../utils/db-pool";

/**
 * GET /admin/finance/customers/:id/open-orders
 *
 * Returns Medusa orders eligible to receive a direct payment application
 * (no PosInvoice yet). Used by payments/new to render the "Medusa Orders"
 * selectable box alongside outstanding invoices.
 *
 * Eligibility:
 *   • Order belongs to the customer
 *   • status NOT IN ('draft','canceled','cancelled')
 *   • Order has NO non-voided PosInvoice (would otherwise be in invoice list)
 *   • Outstanding > 0 (total minus active PaymentApplications)
 *
 * Why raw SQL: Medusa v2 query.graph does not consistently populate the
 * synthetic `total` field on the order entity — it depends on which loaders
 * are wired, and an unloaded total comes back as undefined, which would make
 * every order look like it has zero outstanding and get filtered out. The
 * line-item × quantity sum is the authoritative computation used by other
 * endpoints in this codebase.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const customerId = req.params.id;
  if (!customerId) {
    return res.status(400).json({ error: "Customer ID is required" });
  }

  try {
    const pool = getDbPool();

    interface OrderRow {
      id: string;
      display_id: number | null;
      document_number: string | null;
      status: string;
      currency_code: string;
      created_at: Date | string;
      total_cents: string | number | null;
      applied_cents: string | number | null;
      has_active_invoice: boolean;
    }

    const { rows } = await pool.query<OrderRow>(
      `
      SELECT
        o.id,
        o.display_id,
        NULLIF(o.metadata->>'document_number','')::text AS document_number,
        o.status::text AS status,
        o.currency_code,
        o.created_at,
        COALESCE(
          (
            SELECT SUM(ROUND(oli.unit_price * oi.quantity * 100))::bigint
            FROM order_item oi
            JOIN order_line_item oli ON oli.id = oi.item_id AND oli.deleted_at IS NULL
            WHERE oi.order_id = o.id
          ),
          0
        ) AS total_cents,
        COALESCE(
          (
            SELECT SUM(pa.amount_applied)::bigint
            FROM payment_application pa
            WHERE pa.order_id = o.id
              AND pa.voided_at IS NULL
              AND pa.deleted_at IS NULL
          ),
          0
        ) AS applied_cents,
        EXISTS (
          SELECT 1 FROM pos_invoice pi
          WHERE pi.order_id = o.id
            AND COALESCE(pi.status, '') NOT IN ('voided','draft')
        ) AS has_active_invoice
      FROM "order" o
      WHERE o.customer_id = $1
        AND o.deleted_at IS NULL
        AND COALESCE(o.is_draft_order, false) = false
        AND o.status::text NOT IN ('draft','canceled','cancelled','archived')
      ORDER BY o.created_at DESC
      LIMIT 200
      `,
      [customerId]
    );

    const open_orders = rows
      .filter((r) => !r.has_active_invoice)
      .map((r) => {
        const total = Number(r.total_cents) || 0;
        const applied = Number(r.applied_cents) || 0;
        const outstanding = Math.max(0, total - applied);
        return {
          id: r.id,
          display_id: r.display_id ?? null,
          document_number: r.document_number ?? null,
          status: r.status,
          total_cents: total,
          applied_cents: applied,
          outstanding_cents: outstanding,
          currency_code: r.currency_code ?? "usd",
          created_at:
            r.created_at instanceof Date
              ? r.created_at.toISOString()
              : String(r.created_at),
        };
      })
      .filter((o) => o.outstanding_cents > 0);

    return res.json({ open_orders });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
}
