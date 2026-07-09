import {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { ContainerRegistrationKeys } from "@medusajs/utils";

const MIAMI_LOCATION_ID = "sloc_01KFS2AV3TAKR141KC2D6JCGTR";

// Oldest record in store-pos. "All" history starts here, never before.
const STORE_EPOCH = "2026-04-14T00:00:00.000Z";
const FAR_FUTURE = "2999-01-01T00:00:00.000Z";

type HistoryPeriod = "all" | "this_year" | "last_year";

type RawConnection = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
};

const toInt = (value: unknown): number => {
  if (value === null || value === undefined) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const { variant_id, period: periodRaw } = req.query as Record<string, string>;

  if (!variant_id) {
    return res.status(400).json({ error: "variant_id is required" });
  }

  const period: HistoryPeriod =
    periodRaw === "all" || periodRaw === "last_year" ? periodRaw : "this_year";

  const currentYear = new Date().getUTCFullYear();
  const targetYear = period === "last_year" ? currentYear - 1 : currentYear;

  // periodStart = lower bound of the window. periodEnd = upper bound, or null
  // for "all"/current-year (open-ended → up to now).
  const periodStart =
    period === "all"
      ? STORE_EPOCH
      : new Date(Date.UTC(targetYear, 0, 1)).toISOString();
  const periodEnd =
    period === "all"
      ? null
      : new Date(Date.UTC(targetYear + 1, 0, 1)).toISOString();

  // SQL fragment + bindings for the upper bound on each historical query.
  const upper = (col: string): { clause: string; bind: string[] } =>
    periodEnd
      ? { clause: `AND ${col} >= ? AND ${col} < ?`, bind: [periodStart, periodEnd] }
      : { clause: `AND ${col} >= ?`, bind: [periodStart] };

  const invUpper = upper("i.created_at");
  const cmUpper = upper("cm.created_at");
  const adjUpper = upper("ic.applied_at");
  const rcptUpper = upper("por.received_at");

  const pgConnection = req.scope.resolve(
    ContainerRegistrationKeys.PG_CONNECTION
  ) as RawConnection;

  const [
    invoicedResult,
    returnsResult,
    allocatedResult,
    poResult,
    adjustmentsResult,
    poReceiptsResult,
    currentStateResult,
    sinceResult,
  ] = await Promise.all([
    pgConnection.raw(
      `
      SELECT
        i.id            AS invoice_id,
        i.invoice_number,
        i.created_at,
        i.order_id,
        SUM(ii.quantity)::int AS quantity,
        TRIM(CONCAT(c.first_name, ' ', c.last_name)) AS customer_name,
        COALESCE(c.email, '') AS customer_email
      FROM pos_invoice i
      JOIN pos_invoice_item ii ON ii.invoice_id = i.id AND ii.variant_id = ?
      LEFT JOIN customer c ON c.id = i.customer_id
      WHERE i.deleted_at IS NULL
        AND i.voided_at IS NULL
        AND i.status <> 'voided'
        AND ii.deleted_at IS NULL
        ${invUpper.clause}
      GROUP BY
        i.id,
        i.invoice_number,
        i.created_at,
        i.order_id,
        c.first_name,
        c.last_name,
        c.email
      ORDER BY i.created_at DESC
      LIMIT 1000
      `,
      [variant_id, ...invUpper.bind]
    ),

    pgConnection.raw(
      `
      SELECT
        cm.id              AS credit_memo_id,
        cm.credit_memo_number,
        cm.created_at,
        cm.invoice_id,
        cm.order_id,
        cmi.quantity,
        TRIM(CONCAT(c.first_name, ' ', c.last_name)) AS customer_name,
        COALESCE(c.email, '') AS customer_email
      FROM pos_credit_memo cm
      JOIN pos_credit_memo_item cmi
        ON cmi.credit_memo_id = cm.id AND cmi.variant_id = ?
      LEFT JOIN customer c ON c.id = cm.customer_id
      WHERE cm.deleted_at IS NULL
        AND cm.voided_at IS NULL
        AND cmi.deleted_at IS NULL
        ${cmUpper.clause}
      ORDER BY cm.created_at DESC
      LIMIT 1000
      `,
      [variant_id, ...cmUpper.bind]
    ),

    // Allocated = LIVE open reservations, never year-filtered.
    pgConnection.raw(
      `
      WITH reservation_rows AS (
        SELECT DISTINCT
          ri.id           AS reservation_id,
          o.id            AS order_id,
          o.display_id,
          o.metadata->>'document_number' AS document_number,
          o.created_at,
          ri.quantity,
          ri.created_at   AS reserved_at,
          TRIM(CONCAT(c.first_name, ' ', c.last_name)) AS customer_name,
          COALESCE(c.email, o.email, '') AS customer_email
        FROM reservation_item ri
        JOIN order_line_item oli ON oli.id = ri.line_item_id AND oli.variant_id = ?
        -- item_id -> order_id is invariant across order_item versions, so we
        -- only need ONE row per line item. A correlated MAX(version) subquery
        -- forced a seq scan that ran ~11k times (~22s); LATERAL LIMIT 1 hits
        -- IDX_order_item_item_id and returns the same order_id in <5ms.
        JOIN LATERAL (
          SELECT itm.order_id
          FROM order_item itm
          WHERE itm.item_id = oli.id AND itm.deleted_at IS NULL
          LIMIT 1
        ) oi ON true
        JOIN "order" o ON o.id = oi.order_id
        LEFT JOIN customer c ON c.id = o.customer_id
        WHERE ri.deleted_at IS NULL
          AND o.deleted_at IS NULL
      )
      SELECT
        MIN(reservation_id) AS reservation_id,
        order_id,
        display_id,
        document_number,
        created_at,
        SUM(quantity)::int AS quantity,
        MIN(reserved_at) AS reserved_at,
        customer_name,
        customer_email
      FROM reservation_rows
      GROUP BY
        order_id,
        display_id,
        document_number,
        created_at,
        customer_name,
        customer_email
      ORDER BY created_at DESC
      LIMIT 200
      `,
      [variant_id]
    ),

    // Purchase Orders = open/pending POs, never year-filtered.
    pgConnection.raw(
      `
      SELECT
        po.id           AS po_id,
        po.number       AS po_number,
        po.created_at,
        po.expected_at,
        po.status,
        pol.qty_ordered,
        pol.qty_received,
        po.vendor_id,
        COALESCE(po.vendor_name_snapshot, 'Unknown Vendor') AS vendor_name
      FROM purchase_order_line pol
      JOIN purchase_order po ON po.id = pol.purchase_order_id
      WHERE pol.product_variant_id = ?
        AND pol.deleted_at IS NULL
        AND po.deleted_at IS NULL
        AND po.status <> 'draft'
        AND po.status <> 'voided'
      ORDER BY po.created_at DESC
      LIMIT 200
      `,
      [variant_id]
    ),

    pgConnection.raw(
      `
      SELECT
        ic.id              AS inventory_count_id,
        ic.number          AS count_number,
        ic.applied_at,
        ic.memo,
        icl.id             AS line_id,
        icl.delta_applied,
        icl.qty_at_apply_time,
        icl.qty_at_count_time,
        icl.override_note
      FROM inventory_count_line icl
      JOIN inventory_count ic ON ic.id = icl.inventory_count_id
      WHERE icl.product_variant_id = ?
        AND ic.stock_location_id = ?
        AND ic.status IN ('approved', 'partially_applied')
        AND ic.applied_at IS NOT NULL
        AND icl.deleted_at IS NULL
        AND ic.deleted_at IS NULL
        AND ic.voided_at IS NULL
        AND COALESCE(icl.delta_applied, 0) <> 0
        ${adjUpper.clause}
      ORDER BY ic.applied_at ASC
      `,
      [variant_id, MIAMI_LOCATION_ID, ...adjUpper.bind]
    ),

    pgConnection.raw(
      `
      SELECT
        por.id              AS receipt_id,
        por.number          AS receipt_number,
        por.received_at,
        por.vendor_bill_number,
        porl.qty_received_now,
        po.id               AS po_id,
        po.number           AS po_number,
        COALESCE(po.vendor_name_snapshot, 'Unknown Vendor') AS vendor_name
      FROM purchase_order_receipt_line porl
      JOIN purchase_order_receipt por ON por.id = porl.purchase_order_receipt_id
      JOIN purchase_order po ON po.id = porl.purchase_order_id
      WHERE porl.product_variant_id = ?
        AND por.stock_location_id = ?
        AND por.voided_at IS NULL
        AND por.deleted_at IS NULL
        AND porl.deleted_at IS NULL
        AND COALESCE(porl.qty_received_now, 0) <> 0
        ${rcptUpper.clause}
      ORDER BY por.received_at ASC
      `,
      [variant_id, MIAMI_LOCATION_ID, ...rcptUpper.bind]
    ),

    pgConnection.raw(
      `
      SELECT
        COALESCE(il.stocked_quantity, 0)  AS stocked,
        COALESCE(il.reserved_quantity, 0) AS reserved
      FROM product_variant_inventory_item pvii
      JOIN inventory_level il ON il.inventory_item_id = pvii.inventory_item_id
      WHERE pvii.variant_id = ?
        AND il.location_id = ?
        AND pvii.deleted_at IS NULL
        AND il.deleted_at IS NULL
      LIMIT 1
      `,
      [variant_id, MIAMI_LOCATION_ID]
    ),

    // Net movement from periodStart up to NOW (no upper bound). Used to walk
    // back from current stock to the opening balance at periodStart, so the
    // running balance is correct for ANY period, not just the current year.
    pgConnection.raw(
      `
      SELECT
        COALESCE((
          SELECT SUM(ii.quantity)
          FROM pos_invoice i
          JOIN pos_invoice_item ii ON ii.invoice_id = i.id AND ii.variant_id = ?
          WHERE i.deleted_at IS NULL AND i.voided_at IS NULL AND i.status <> 'voided'
            AND ii.deleted_at IS NULL AND i.created_at >= ?
        ), 0)::int AS sold,
        COALESCE((
          SELECT SUM(cmi.quantity)
          FROM pos_credit_memo cm
          JOIN pos_credit_memo_item cmi ON cmi.credit_memo_id = cm.id AND cmi.variant_id = ?
          WHERE cm.deleted_at IS NULL AND cm.voided_at IS NULL
            AND cmi.deleted_at IS NULL AND cm.created_at >= ?
        ), 0)::int AS returned,
        COALESCE((
          SELECT SUM(porl.qty_received_now)
          FROM purchase_order_receipt_line porl
          JOIN purchase_order_receipt por ON por.id = porl.purchase_order_receipt_id
          WHERE porl.product_variant_id = ? AND por.stock_location_id = ?
            AND por.voided_at IS NULL AND por.deleted_at IS NULL
            AND porl.deleted_at IS NULL AND por.received_at >= ?
        ), 0)::int AS received,
        COALESCE((
          SELECT SUM(icl.delta_applied)
          FROM inventory_count_line icl
          JOIN inventory_count ic ON ic.id = icl.inventory_count_id
          WHERE icl.product_variant_id = ? AND ic.stock_location_id = ?
            AND ic.status IN ('approved', 'partially_applied') AND ic.applied_at IS NOT NULL
            AND icl.deleted_at IS NULL AND ic.deleted_at IS NULL AND ic.voided_at IS NULL
            AND ic.applied_at >= ?
        ), 0)::int AS adjusted
      `,
      [
        variant_id, periodStart,
        variant_id, periodStart,
        variant_id, MIAMI_LOCATION_ID, periodStart,
        variant_id, MIAMI_LOCATION_ID, periodStart,
      ]
    ),
  ]);

  const invoicedRows = invoicedResult.rows as Array<Record<string, unknown>>;
  const returnsRows = returnsResult.rows as Array<Record<string, unknown>>;
  const adjustmentsRows = adjustmentsResult.rows as Array<Record<string, unknown>>;
  const poReceiptsRows = poReceiptsResult.rows as Array<Record<string, unknown>>;

  const stateRow = (currentStateResult.rows[0] ?? {}) as Record<string, unknown>;
  const stocked = toInt(stateRow.stocked);
  const reserved = toInt(stateRow.reserved);
  const available = stocked - reserved;

  // beginning_balance = stock at periodStart = current stock minus every
  // movement recorded since periodStart.
  const sinceRow = (sinceResult.rows[0] ?? {}) as Record<string, unknown>;
  const netSincePeriodStart =
    -toInt(sinceRow.sold) +
    toInt(sinceRow.returned) +
    toInt(sinceRow.received) +
    toInt(sinceRow.adjusted);
  const beginning_balance = stocked - netSincePeriodStart;

  return res.json({
    invoiced: invoicedRows,
    returns: returnsRows,
    allocated: allocatedResult.rows,
    purchase_orders: poResult.rows,
    adjustments: adjustmentsRows,
    po_receipts: poReceiptsRows,
    current_state: { stocked, reserved, available },
    beginning_balance,
    period,
    year: targetYear,
    year_window: { start: periodStart, end: periodEnd ?? FAR_FUTURE },
  });
}
