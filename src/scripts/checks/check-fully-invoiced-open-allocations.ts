/**
 * ⛔ DEPRECATED 2026-07-10 — its signal is INVERTED under the apartado policy:
 * an invoiced-but-undispatched order KEEPING its reservations is now the
 * CORRECT state (they release only at real fulfillment: pickup/dispatch), so
 * everything this check flags as "bad" is healthy. Kept for history; exits
 * immediately. For genuinely stale reservations, audit closed/completed
 * orders (release-closed-order-reservations.ts /
 * release-completed-order-stale-reservations.ts).
 */
import type { ExecArgs } from "@medusajs/framework/types";

interface CandidateRow {
  order_id: string;
  display_id: number;
  custom_display_id: string | null;
  email: string | null;
  order_status: string | null;
  invoice_numbers: string;
  active_invoice_count: string;
  line_count: string;
  reserved_qty: string;
  reservation_count: string;
  uninvoiced_by_ui_count: string;
  aggregate_short_skus: string | null;
  updated_at: Date;
}

export default async function checkFullyInvoicedOpenAllocations({
  container,
}: ExecArgs) {
  console.error(
    "⛔ DEPRECATED (2026-07-10): invoiced orders keeping reservations is now " +
      "the CORRECT state (apartado policy) — this check's signal is inverted."
  );
  const DEPRECATED = true;
  if (DEPRECATED) return;

  const pg = container.resolve("__pg_connection__") as any;
  const limit = Math.max(1, Number(process.env.LIMIT ?? 200));

  const { rows } = (await pg.raw(
    `
    WITH active_invoice AS (
      SELECT pi.*
      FROM pos_invoice pi
      WHERE pi.deleted_at IS NULL
        AND pi.status NOT IN ('voided', 'draft')
    ),
    invoice_lines AS (
      SELECT
        pi.order_id,
        pii.variant_id,
        pii.sku,
        SUM(pii.quantity)::numeric AS qty
      FROM active_invoice pi
      JOIN pos_invoice_item pii ON pii.invoice_id = pi.id
      WHERE pii.deleted_at IS NULL
      GROUP BY pi.order_id, pii.variant_id, pii.sku
    ),
    invoice_consumption AS (
      SELECT
        ol.order_id,
        ol.line_item_id,
        ol.order_qty,
        COALESCE(SUM(
          GREATEST(
            0,
            LEAST(
              il.qty - COALESCE(prev.prev_qty, 0),
              ol.order_qty
            )
          )
        ), 0)::numeric AS allocated_invoice_qty
      FROM (
        SELECT
          o.id AS order_id,
          oi.item_id AS line_item_id,
          oli.variant_id,
          oli.variant_sku,
          oi.quantity::numeric AS order_qty,
          COALESCE(SUM(oi.quantity::numeric) OVER (
            PARTITION BY o.id, COALESCE(oli.variant_sku, oli.variant_id)
            ORDER BY oli.created_at, oi.item_id
            ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
          ), 0)::numeric AS previous_order_qty
        FROM "order" o
        JOIN order_item oi ON oi.order_id = o.id AND oi.deleted_at IS NULL
        JOIN order_line_item oli ON oli.id = oi.item_id AND oli.deleted_at IS NULL
        WHERE o.deleted_at IS NULL
          AND o.canceled_at IS NULL
          AND oi.quantity > 0
      ) ol
      LEFT JOIN LATERAL (
        SELECT SUM(il.qty)::numeric AS qty
        FROM invoice_lines il
        WHERE il.order_id = ol.order_id
          AND (
            (il.variant_id IS NOT NULL AND il.variant_id = ol.variant_id)
            OR (il.sku IS NOT NULL AND il.sku = ol.variant_sku)
          )
      ) il ON true
      LEFT JOIN LATERAL (
        SELECT ol.previous_order_qty AS prev_qty
      ) prev ON true
      GROUP BY ol.order_id, ol.line_item_id, ol.order_qty
    ),
    order_lines AS (
      SELECT
        o.id AS order_id,
        o.display_id,
        o.custom_display_id,
        o.email,
        o.updated_at,
        o.metadata->>'order_status' AS order_status,
        oi.item_id AS line_item_id,
        oli.variant_id,
        oli.variant_sku,
        oi.quantity::numeric AS order_qty,
        COALESCE(ic.allocated_invoice_qty, 0)::numeric AS line_invoiced_qty,
        COALESCE((
          SELECT SUM(ri.quantity)
          FROM reservation_item ri
          WHERE ri.line_item_id = oi.item_id
            AND ri.deleted_at IS NULL
        ), 0)::numeric AS reserved_qty,
        COALESCE((
          SELECT COUNT(*)
          FROM reservation_item ri
          WHERE ri.line_item_id = oi.item_id
            AND ri.deleted_at IS NULL
        ), 0)::int AS reservation_count
      FROM "order" o
      JOIN order_item oi ON oi.order_id = o.id AND oi.deleted_at IS NULL
      JOIN order_line_item oli ON oli.id = oi.item_id AND oli.deleted_at IS NULL
      LEFT JOIN invoice_consumption ic ON ic.order_id = o.id AND ic.line_item_id = oi.item_id
      WHERE o.deleted_at IS NULL
        AND o.canceled_at IS NULL
        AND oi.quantity > 0
    ),
    aggregate_invoice AS (
      SELECT
        order_id,
        COALESCE(sku, variant_id) AS key,
        SUM(qty)::numeric AS invoice_qty
      FROM invoice_lines
      GROUP BY order_id, COALESCE(sku, variant_id)
    ),
    aggregate_order AS (
      SELECT
        order_id,
        COALESCE(variant_sku, variant_id) AS key,
        SUM(order_qty)::numeric AS order_qty
      FROM order_lines
      GROUP BY order_id, COALESCE(variant_sku, variant_id)
    ),
    aggregate_short AS (
      SELECT
        ao.order_id,
        STRING_AGG(
          ao.key || ' order=' || ao.order_qty::text || ' invoiced=' || COALESCE(ai.invoice_qty, 0)::text,
          ', '
          ORDER BY ao.key
        ) FILTER (WHERE COALESCE(ai.invoice_qty, 0) < ao.order_qty) AS aggregate_short_skus
      FROM aggregate_order ao
      LEFT JOIN aggregate_invoice ai ON ai.order_id = ao.order_id AND ai.key = ao.key
      GROUP BY ao.order_id
    ),
    invoice_summary AS (
      SELECT
        order_id,
        COUNT(*) AS active_invoice_count,
        STRING_AGG(invoice_number, ', ' ORDER BY issued_at NULLS LAST, created_at) AS invoice_numbers
      FROM active_invoice
      GROUP BY order_id
    )
    SELECT
      ol.order_id,
      ol.display_id,
      ol.custom_display_id,
      ol.email,
      ol.order_status,
      COALESCE(inv.invoice_numbers, '') AS invoice_numbers,
      COALESCE(inv.active_invoice_count, 0)::text AS active_invoice_count,
      COUNT(*)::text AS line_count,
      SUM(ol.reserved_qty)::text AS reserved_qty,
      SUM(ol.reservation_count)::text AS reservation_count,
      SUM(CASE WHEN ol.line_invoiced_qty < ol.order_qty THEN 1 ELSE 0 END)::text AS uninvoiced_by_ui_count,
      ash.aggregate_short_skus,
      MAX(ol.updated_at) AS updated_at
    FROM order_lines ol
    JOIN invoice_summary inv ON inv.order_id = ol.order_id
    LEFT JOIN aggregate_short ash ON ash.order_id = ol.order_id
    GROUP BY
      ol.order_id,
      ol.display_id,
      ol.custom_display_id,
      ol.email,
      ol.order_status,
      inv.invoice_numbers,
      inv.active_invoice_count,
      ash.aggregate_short_skus
    HAVING
      SUM(ol.reserved_qty) > 0
      AND SUM(CASE WHEN ol.line_invoiced_qty < ol.order_qty THEN 1 ELSE 0 END) = 0
    ORDER BY MAX(ol.updated_at) DESC
    LIMIT ?
    `,
    [limit]
  )) as { rows: CandidateRow[] };

  if (!rows.length) {
    console.log("OK: no fully-invoiced POS orders with open allocations found.");
    return;
  }

  console.log(
    `Found ${rows.length} fully-invoiced POS order(s) with open allocations:\n`
  );
  for (const row of rows) {
    const label = row.custom_display_id || `#${row.display_id}`;
    console.log(
      [
        `${label} ${row.order_id}`,
        `email=${row.email ?? ""}`,
        `status=${row.order_status ?? ""}`,
        `invoices=${row.invoice_numbers}`,
        `reserved_qty=${row.reserved_qty}`,
        `reservations=${row.reservation_count}`,
        `updated=${row.updated_at.toISOString()}`,
      ].join(" | ")
    );
    if (row.aggregate_short_skus) {
      console.log(`  note: aggregate SKU quantities short: ${row.aggregate_short_skus}`);
    }
  }
}
