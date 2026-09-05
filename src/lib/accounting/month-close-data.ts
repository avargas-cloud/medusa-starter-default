import { avgCostDollars } from "../cost/cost-sql";
import { etMidnightUtc } from "../date/et";
import {
  COGS_JOIN,
  COST_DOLLARS,
} from "../../api/admin/reports/_lib/cogs-join";
import {
  NET_ITEM_REVENUE,
  SALES_ACTIVE_STATUSES_SQL,
  SALES_DATE_FILTER_SQL,
  fetchCmRefundsCentsForPeriod,
} from "../../api/admin/reports/_lib/sales-revenue";
import { fetchShippingCentsForPeriod } from "../../api/admin/reports/_lib/shipping-revenue";

export interface SqlClient {
  raw: (
    sql: string,
    bindings?: unknown[]
  ) => Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number }>;
}

export interface MonthRange {
  month: string;
  from: string;
  to: string;
  periodStart: string;
  periodEnd: string;
}

export interface MonthSummary {
  gross_sales: number;
  discounts: number;
  returns: number;
  net_revenue: number;
  cogs: number;
  inventory_adjustments: number;
  prior_period_adjustments: number;
  gross_profit: number;
  margin_pct: number;
  invoices: number;
  units: number;
  average_order_value: number;
  total_customers: number;
  new_customers: number;
}

export interface OpenDocumentCounts {
  orders: number;
  invoices: number;
  purchase_orders: number;
  vendor_bills: number;
  credit_memos: number;
  inventory_adjustments: number;
  qb_unsynced: number;
}

export function parseMonth(value: unknown): MonthRange | null {
  if (typeof value !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) {
    return null;
  }
  const [yearText, monthText] = value.split("-");
  const year = Number(yearText);
  const monthIndex = Number(monthText) - 1;
  const start = etMidnightUtc(year, monthIndex);
  const end = etMidnightUtc(year, monthIndex + 1);
  // Calendar day of the ET period boundary — derived directly from
  // year/monthIndex, NOT from start/end.toISOString() (which would give the
  // UTC calendar date, off by one near month boundaries in ET).
  const periodStartMonthIndex = monthIndex;
  const periodStartYear = year;
  const periodEndMonthIndex = monthIndex + 1 > 11 ? 0 : monthIndex + 1;
  const periodEndYear = monthIndex + 1 > 11 ? year + 1 : year;
  const periodStart = `${periodStartYear}-${String(periodStartMonthIndex + 1).padStart(2, "0")}-01`;
  const periodEnd = `${periodEndYear}-${String(periodEndMonthIndex + 1).padStart(2, "0")}-01`;
  return {
    month: value,
    from: start.toISOString(),
    to: end.toISOString(),
    periodStart,
    periodEnd,
  };
}

export async function loadMonthSummary(
  db: SqlClient,
  range: MonthRange
): Promise<MonthSummary> {
  const [
    sales,
    discounts,
    adjustments,
    priorPeriodAdjustments,
    returnsCents,
    customers,
    shippingCents,
  ] = await Promise.all([
    db.raw(
      `SELECT COUNT(DISTINCT i.id)::int AS invoices,
              COALESCE(SUM(${NET_ITEM_REVENUE}), 0)::bigint AS revenue,
              COALESCE(SUM(${COST_DOLLARS}), 0)::numeric AS cogs,
              COALESCE(SUM(CASE
                WHEN pii.variant_id IS NOT NULL OR pii.sku IS NOT NULL OR pii.unit_price > 0
                THEN pii.quantity ELSE 0 END), 0)::int AS units
         FROM pos_invoice i
         JOIN pos_invoice_item pii ON pii.invoice_id = i.id AND pii.deleted_at IS NULL
         ${COGS_JOIN}
        WHERE i.deleted_at IS NULL
          AND ${SALES_ACTIVE_STATUSES_SQL}
          AND ${SALES_DATE_FILTER_SQL}`,
      [range.from, range.to]
    ),
    db.raw(
      `SELECT COALESCE(SUM(i.discount), 0)::bigint AS amount
         FROM pos_invoice i
        WHERE i.deleted_at IS NULL
          AND ${SALES_ACTIVE_STATUSES_SQL}
          AND ${SALES_DATE_FILTER_SQL}`,
      [range.from, range.to]
    ),
    db.raw(
      `SELECT COALESCE(SUM(
                icl.delta_applied::numeric * COALESCE(${avgCostDollars("pv")}, 0)
              ), 0)::numeric AS amount
         FROM inventory_count ic
         JOIN inventory_count_line icl ON icl.inventory_count_id = ic.id
           AND icl.deleted_at IS NULL
           AND icl.status IN ('applied', 'overridden')
         LEFT JOIN product_variant pv ON pv.id = icl.product_variant_id
        WHERE ic.deleted_at IS NULL AND ic.voided_at IS NULL
          AND ic.applied_at >= ? AND ic.applied_at < ?`,
      [range.from, range.to]
    ),
    db.raw(
      `SELECT COALESCE(SUM((delta->>'cogs')::numeric), 0) AS cogs
         FROM accounting_period_adjustment
        WHERE status = 'posted' AND target_period_start = ?::date`,
      [range.periodStart]
    ),
    fetchCmRefundsCentsForPeriod(db as never, range.from, range.to),
    db.raw(
      `WITH first_purchase AS (
       SELECT customer_id, MIN(issued_at) AS first_purchase_at
           FROM pos_invoice i
          WHERE deleted_at IS NULL
            AND ${SALES_ACTIVE_STATUSES_SQL}
            AND customer_id IS NOT NULL
          GROUP BY customer_id
       )
       SELECT
         COUNT(DISTINCT i.customer_id)::int AS total_customers,
         COUNT(DISTINCT CASE
           WHEN fp.first_purchase_at >= ? AND fp.first_purchase_at < ?
                AND (c.metadata->>'legacy_customer') IS DISTINCT FROM 'true'
           THEN i.customer_id
         END)::int AS new_customers
       FROM pos_invoice i
       JOIN customer c ON c.id = i.customer_id
       JOIN first_purchase fp ON fp.customer_id = i.customer_id
      WHERE i.deleted_at IS NULL
        AND ${SALES_ACTIVE_STATUSES_SQL}
        AND i.customer_id IS NOT NULL
        AND ${SALES_DATE_FILTER_SQL}`,
      [range.from, range.to, range.from, range.to]
    ),
    fetchShippingCentsForPeriod(db as never, range.from, range.to),
  ]);

  const row = sales.rows[0] ?? {};
  // El flete es ingreso de ventas en QuickBooks: sin él el cierre de mes queda
  // por debajo del *Sales by Customer Summary* con el que se concilia.
  const grossSales = (Number(row.revenue ?? 0) + Number(shippingCents)) / 100;
  const returns = Number(returnsCents) / 100;
  const inventoryAdjustments = Number(adjustments.rows[0]?.amount ?? 0);
  const priorPeriodAdjustment = Number(
    priorPeriodAdjustments.rows[0]?.cogs ?? 0
  );
  const merchandiseCogs = Number(row.cogs ?? 0);
  const cogs =
    merchandiseCogs + inventoryAdjustments + priorPeriodAdjustment;
  const netRevenue = grossSales - returns;
  const grossProfit = netRevenue - cogs;
  const invoices = Number(row.invoices ?? 0);

  return {
    gross_sales: grossSales,
    discounts: Number(discounts.rows[0]?.amount ?? 0) / 100,
    returns,
    net_revenue: netRevenue,
    cogs,
    inventory_adjustments: inventoryAdjustments,
    prior_period_adjustments: priorPeriodAdjustment,
    gross_profit: grossProfit,
    margin_pct: netRevenue === 0 ? 0 : (grossProfit / netRevenue) * 100,
    invoices,
    units: Number(row.units ?? 0),
    average_order_value: invoices === 0 ? 0 : grossSales / invoices,
    total_customers: Number(customers.rows[0]?.total_customers ?? 0),
    new_customers: Number(customers.rows[0]?.new_customers ?? 0),
  };
}

export async function loadOpenDocuments(
  db: SqlClient,
  range: MonthRange
): Promise<OpenDocumentCounts> {
  const result = await db.raw(
    `SELECT
       (SELECT COUNT(*) FROM "order" o
         WHERE o.deleted_at IS NULL
           AND COALESCE(NULLIF(o.metadata->>'order_placed_at', '')::timestamptz, o.created_at) >= ?
           AND COALESCE(NULLIF(o.metadata->>'order_placed_at', '')::timestamptz, o.created_at) < ?
           AND o.is_draft_order = false
           AND o.status NOT IN ('completed','canceled','archived')
           AND COALESCE((o.metadata->>'pos_closed')::boolean, false) = false
           AND COALESCE(o.metadata->>'qb_sync_status', '') <> 'voided'
           AND (
             NOT EXISTS (
               SELECT 1
                 FROM order_fulfillment ofl
                 JOIN fulfillment f ON f.id = ofl.fulfillment_id
                WHERE ofl.order_id = o.id
                  AND f.deleted_at IS NULL
                  AND f.canceled_at IS NULL
             )
             OR EXISTS (
               SELECT 1
                 FROM order_item oi
                WHERE oi.order_id = o.id
                  AND oi.deleted_at IS NULL
                  AND oi.version = (
                    SELECT MAX(oi2.version)
                      FROM order_item oi2
                     WHERE oi2.order_id = oi.order_id
                       AND oi2.item_id = oi.item_id
                       AND oi2.deleted_at IS NULL
                  )
                  AND COALESCE(oi.fulfilled_quantity, 0) < oi.quantity
             )
             OR EXISTS (
               SELECT 1
                 FROM order_fulfillment ofl
                 JOIN fulfillment f ON f.id = ofl.fulfillment_id
                WHERE ofl.order_id = o.id
                  AND f.deleted_at IS NULL
                  AND f.canceled_at IS NULL
                  AND f.packed_at IS NULL
                  AND f.shipped_at IS NULL
                  AND f.delivered_at IS NULL
             )
           ))::int AS orders,
       (SELECT COUNT(*) FROM pos_invoice i
         WHERE i.deleted_at IS NULL
           AND COALESCE(i.issued_at, i.created_at) >= ?
           AND COALESCE(i.issued_at, i.created_at) < ?
           AND i.status <> 'voided'
           AND (
             i.balance_due > 0
             OR i.fulfillment_id IS NULL
             OR EXISTS (
               SELECT 1
                 FROM fulfillment f
                WHERE f.id = i.fulfillment_id
                  AND f.deleted_at IS NULL
                  AND f.canceled_at IS NOT NULL
             )
             OR NOT EXISTS (
               SELECT 1
                 FROM fulfillment f
                WHERE f.id = i.fulfillment_id
                  AND f.deleted_at IS NULL
                  AND f.canceled_at IS NULL
                  AND (
                    f.shipped_at IS NOT NULL
                    OR f.delivered_at IS NOT NULL
                    OR EXISTS (
                      SELECT 1
                        FROM fulfillment_label l
                       WHERE l.fulfillment_id = f.id
                         AND l.deleted_at IS NULL
                    )
                  )
             )
           ))::int AS invoices,
       (SELECT COUNT(*) FROM purchase_order po
         WHERE po.deleted_at IS NULL
           AND COALESCE(po.ordered_at, po.created_at) >= ?
           AND COALESCE(po.ordered_at, po.created_at) < ?
           AND po.status NOT IN ('received','closed','cancelled','voided'))::int AS purchase_orders,
       (SELECT COUNT(*) FROM vendor_bill vb
         WHERE vb.deleted_at IS NULL
           AND COALESCE(vb.document_date, vb.created_at) >= ?
           AND COALESCE(vb.document_date, vb.created_at) < ?
           AND (vb.status = 'draft' OR COALESCE(vb.qb_is_paid, false) = false))::int AS vendor_bills,
       (SELECT COUNT(*) FROM pos_credit_memo cm
         WHERE cm.deleted_at IS NULL AND cm.created_at >= ? AND cm.created_at < ?
           AND cm.status NOT IN ('completed','voided'))::int AS credit_memos,
       (SELECT COUNT(*) FROM inventory_count ic
         WHERE ic.deleted_at IS NULL AND ic.created_at >= ? AND ic.created_at < ?
           AND ic.status IN ('draft','submitted','partially_applied'))::int AS inventory_adjustments,
       (SELECT COUNT(*) FROM qb_order_pipeline qp
         WHERE qp.created_at >= ? AND qp.created_at < ?
           AND qp.status IN ('pending','processing','submitted','waiting','failed'))::int AS qb_unsynced`,
    [
      range.from, range.to,
      range.from, range.to,
      range.from, range.to,
      range.from, range.to,
      range.from, range.to,
      range.from, range.to,
      range.from, range.to,
    ]
  );
  const row = result.rows[0] ?? {};
  return {
    orders: Number(row.orders ?? 0),
    invoices: Number(row.invoices ?? 0),
    purchase_orders: Number(row.purchase_orders ?? 0),
    vendor_bills: Number(row.vendor_bills ?? 0),
    credit_memos: Number(row.credit_memos ?? 0),
    inventory_adjustments: Number(row.inventory_adjustments ?? 0),
    qb_unsynced: Number(row.qb_unsynced ?? 0),
  };
}

export function buildReadiness(open: OpenDocumentCounts) {
  return {
    warnings: {
      orders: open.orders,
      purchase_orders: open.purchase_orders,
      invoices: open.invoices,
      vendor_bills: open.vendor_bills,
    },
    blockers: {
      credit_memos: open.credit_memos,
      inventory_adjustments: open.inventory_adjustments,
      qb_unsynced: open.qb_unsynced,
    },
    has_warnings:
      open.orders + open.purchase_orders + open.invoices + open.vendor_bills > 0,
    has_blockers:
      open.credit_memos + open.inventory_adjustments + open.qb_unsynced > 0,
  };
}

export function summaryDelta(
  original: MonthSummary,
  current: MonthSummary
): MonthSummary {
  const delta = {} as MonthSummary;
  for (const key of Object.keys(original) as Array<keyof MonthSummary>) {
    delta[key] = current[key] - original[key];
  }
  return delta;
}

export function normalizeMonthSummary(
  snapshot: Partial<MonthSummary>,
  current: MonthSummary
): MonthSummary {
  return { ...current, ...snapshot };
}
