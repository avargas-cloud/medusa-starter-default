import {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { ContainerRegistrationKeys } from "@medusajs/utils";

const MIAMI_LOCATION_ID = "sloc_01KFS2AV3TAKR141KC2D6JCGTR";

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
  const { variant_id, year: yearRaw } = req.query as Record<string, string>;

  if (!variant_id) {
    return res.status(400).json({ error: "variant_id is required" });
  }

  const year = Number.parseInt(yearRaw ?? "", 10);
  const targetYear = Number.isFinite(year) && year > 1900 ? year : new Date().getUTCFullYear();
  const yearStart = new Date(Date.UTC(targetYear, 0, 1)).toISOString();
  const yearEnd = new Date(Date.UTC(targetYear + 1, 0, 1)).toISOString();

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
      GROUP BY
        i.id,
        i.invoice_number,
        i.created_at,
        i.order_id,
        c.first_name,
        c.last_name,
        c.email
      ORDER BY i.created_at DESC
      LIMIT 200
      `,
      [variant_id]
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
      ORDER BY cm.created_at DESC
      LIMIT 200
      `,
      [variant_id]
    ),

    pgConnection.raw(
      `
      WITH reservation_rows AS (
        SELECT DISTINCT
          ri.id           AS reservation_id,
          o.id            AS order_id,
          o.display_id,
          o.created_at,
          ri.quantity,
          ri.created_at   AS reserved_at,
          TRIM(CONCAT(c.first_name, ' ', c.last_name)) AS customer_name,
          COALESCE(c.email, o.email, '') AS customer_email
        FROM reservation_item ri
        JOIN order_line_item oli ON oli.id = ri.line_item_id AND oli.variant_id = ?
        JOIN order_item oi ON oi.item_id = oli.id
          AND oi.version = (SELECT MAX(oi2.version) FROM order_item oi2 WHERE oi2.order_id = oi.order_id)
        JOIN "order" o ON o.id = oi.order_id
        LEFT JOIN customer c ON c.id = o.customer_id
        WHERE ri.deleted_at IS NULL
          AND o.deleted_at IS NULL
      )
      SELECT
        MIN(reservation_id) AS reservation_id,
        order_id,
        display_id,
        created_at,
        SUM(quantity)::int AS quantity,
        MIN(reserved_at) AS reserved_at,
        customer_name,
        customer_email
      FROM reservation_rows
      GROUP BY
        order_id,
        display_id,
        created_at,
        customer_name,
        customer_email
      ORDER BY created_at DESC
      LIMIT 200
      `,
      [variant_id]
    ),

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
        AND ic.applied_at >= ?
        AND ic.applied_at < ?
        AND icl.deleted_at IS NULL
        AND ic.deleted_at IS NULL
        AND ic.voided_at IS NULL
        AND COALESCE(icl.delta_applied, 0) <> 0
      ORDER BY ic.applied_at ASC
      `,
      [variant_id, MIAMI_LOCATION_ID, yearStart, yearEnd]
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
        AND por.received_at >= ?
        AND por.received_at < ?
        AND COALESCE(porl.qty_received_now, 0) <> 0
      ORDER BY por.received_at ASC
      `,
      [variant_id, MIAMI_LOCATION_ID, yearStart, yearEnd]
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
  ]);

  const invoicedRows = invoicedResult.rows as Array<Record<string, unknown>>;
  const returnsRows = returnsResult.rows as Array<Record<string, unknown>>;
  const adjustmentsRows = adjustmentsResult.rows as Array<Record<string, unknown>>;
  const poReceiptsRows = poReceiptsResult.rows as Array<Record<string, unknown>>;

  const stateRow = (currentStateResult.rows[0] ?? {}) as Record<string, unknown>;
  const stocked = toInt(stateRow.stocked);
  const reserved = toInt(stateRow.reserved);
  const available = stocked - reserved;

  const inYear = (raw: unknown): boolean => {
    if (!raw) return false;
    const iso = raw instanceof Date ? raw.toISOString() : String(raw);
    return iso >= yearStart && iso < yearEnd;
  };

  const sumYear = (rows: Array<Record<string, unknown>>, dateKey: string, qtyKey: string, sign: 1 | -1): number =>
    rows.reduce((acc, row) => (inYear(row[dateKey]) ? acc + sign * toInt(row[qtyKey]) : acc), 0);

  const yearSalesDelta = sumYear(invoicedRows, "created_at", "quantity", -1);
  const yearReturnsDelta = sumYear(returnsRows, "created_at", "quantity", 1);
  const yearReceiptsDelta = poReceiptsRows.reduce(
    (acc, row) => acc + toInt(row.qty_received_now),
    0
  );
  const yearAdjustmentsDelta = adjustmentsRows.reduce(
    (acc, row) => acc + toInt(row.delta_applied),
    0
  );

  const yearMovementsTotal =
    yearSalesDelta + yearReturnsDelta + yearReceiptsDelta + yearAdjustmentsDelta;

  const beginning_balance = stocked - yearMovementsTotal;

  return res.json({
    invoiced: invoicedRows,
    returns: returnsRows,
    allocated: allocatedResult.rows,
    purchase_orders: poResult.rows,
    adjustments: adjustmentsRows,
    po_receipts: poReceiptsRows,
    current_state: { stocked, reserved, available },
    beginning_balance,
    year: targetYear,
    year_window: { start: yearStart, end: yearEnd },
  });
}
