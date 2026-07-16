import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { getDbPool } from "../../../../../utils/db-pool";

/**
 * GET /admin/finance/customers/:id/open-orders
 *
 * Returns Medusa orders that still have a linkable balance for a direct
 * order-only payment application. Used by payments/new to render the
 * "Medusa Orders" selectable box AND by the payment "Link to Order" modal.
 *
 * Eligibility:
 *   • Order belongs to the customer
 *   • status NOT IN ('draft','canceled','cancelled')
 *   • Outstanding > 0
 *
 * Outstanding = total − Σ(all active PaymentApplications) — which is exactly
 * the reservation engine's `gap` (allowed − orderOnlyLinked, where allowed =
 * total − invoiceBound). Total is sourced from `metadata.pos_total` first (the
 * SAME source `reconcile-order-reservations` uses) so the picker's outstanding
 * matches the gap the server will actually enforce on apply — a partially
 * invoiced order therefore stays linkable for its remaining balance (a fully
 * invoiced+paid order falls out via outstanding=0). We intentionally do NOT
 * exclude orders that already have a PosInvoice: a partial invoice leaves real
 * un-invoiced balance that a deposit can still be reserved against, and CONVERT-
 * ON-APPLY + the gap clamp prevent any double-consumption.
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
      pos_total_raw: string | null;
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
        -- Preferred total source: metadata.pos_total (DOLLARS) — the SAME source
        -- reconcile-order-reservations uses. Kept as raw text and parsed in JS
        -- (mirrors the engine's Number()+isFinite guard) so a malformed value
        -- can never crash the query via a bad ::numeric cast.
        NULLIF(o.metadata->>'pos_total','') AS pos_total_raw,
        -- Fallback order total comes from order_summary.totals.original_order_total
        -- (matches the value rendered on the orders list — includes tax, shipping,
        -- discounts). Falls back to the line-item sum if no summary row exists
        -- (extremely old orders that predate the summary migration).
        COALESCE(
          (
            SELECT ROUND(((os.totals->>'original_order_total')::numeric) * 100)::bigint
            FROM order_summary os
            WHERE os.order_id = o.id AND os.deleted_at IS NULL
              AND (os.totals->>'original_order_total') IS NOT NULL
            ORDER BY os.version DESC
            LIMIT 1
          ),
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
      .map((r) => {
        // Prefer metadata.pos_total (dollars) to match the reservation engine;
        // fall back to the order_summary/line-item total (already in cents).
        const posTotalDollars = Number(r.pos_total_raw);
        const total =
          Number.isFinite(posTotalDollars) && posTotalDollars > 0
            ? Math.round(posTotalDollars * 100)
            : Number(r.total_cents) || 0;
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
          // Surfaced so the UI can label a partially-invoiced order as a top-up.
          has_active_invoice: r.has_active_invoice,
          currency_code: r.currency_code ?? "usd",
          created_at:
            r.created_at instanceof Date
              ? r.created_at.toISOString()
              : String(r.created_at),
        };
      })
      // Keep any order that still has linkable balance — a partial invoice
      // leaves real remainder; a fully invoiced+paid order lands at 0 and drops.
      .filter((o) => o.outstanding_cents > 0);

    return res.json({ open_orders });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
}
