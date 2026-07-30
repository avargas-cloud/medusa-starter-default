import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { Client } from "pg";

import {
  BILL_PAYMENT_STEPS,
  PURCHASE_PIPELINE_STEPS,
} from "../../../../lib/quickbooks/pipeline/sales-pipeline-scope";

/**
 * GET /admin/quickbooks/pipeline-summary
 *
 * Returns live counts for every Medusa-side QB pipeline, normalized into a
 * shared 5-bucket model. Drives the per-pipeline breakdown card on the
 * QuickBooks Pipelines admin page.
 */

type Bucket = "pending" | "processing" | "completed" | "failed" | "skipped";

export type PipelineSummary = {
  key: string;
  label: string;
  tab: string;
  counts: Record<Bucket, number>;
  total: number;
};

const BUCKETS: Bucket[] = [
  "pending",
  "processing",
  "completed",
  "failed",
  "skipped",
];

const zeroCounts = (): Record<Bucket, number> =>
  Object.fromEntries(BUCKETS.map((b) => [b, 0])) as Record<Bucket, number>;

// Maps raw status strings from any pipeline table into the shared 5-bucket model.
const STATUS_BUCKET: Record<string, Bucket> = {
  // pending family
  pending: "pending",
  waiting: "pending",
  // in-flight family
  submitted: "processing",
  processing: "processing",
  // success family
  synced: "completed",
  confirmed: "completed",
  fixed: "completed",
  completed: "completed",
  // failure family
  error: "failed",
  failed: "failed",
  failed_permanent: "failed",
  // intentional no-op
  skipped: "skipped",
  cancelled: "skipped",
};

const bucketOf = (status: string | null | undefined): Bucket | null => {
  if (!status) return null;
  return STATUS_BUCKET[status] ?? null;
};

type StatusRow = { status: string; count: string };

const accumulate = (
  rows: StatusRow[]
): { counts: Record<Bucket, number>; total: number } => {
  const counts = zeroCounts();
  let total = 0;
  for (const row of rows) {
    const bucket = bucketOf(row.status);
    if (!bucket) continue;
    const n = parseInt(row.count, 10) || 0;
    counts[bucket] += n;
    total += n;
  }
  return { counts, total };
};

/**
 * The Customer Sync TAB fetches both of these steps, so the breakdown counts both.
 * Kept local because it differs from the scope module's CUSTOMER_SYNC_STEPS, which
 * lists only `customer_data_ext` — the Sales Pipeline tab does still show `customer`
 * rows. Do not "unify" these two without deciding which tab owns `customer`.
 */
const CUSTOMER_STEPS = ["customer", "customer_data_ext"];

/**
 * Steps this card must NOT count under Sales, because they render in their own tab.
 *
 * Imported, never re-typed. This route was the THIRD hand-written copy of the same
 * list — the two the scope module was created for were the listing query and its
 * badge summary, and nobody remembered this card existed. The symptom the operator
 * saw: 756 confirmed and 4 failed bill-payment checks counted under "Sales" while the
 * Sales Pipeline tab, correctly, showed none of them.
 */
const NON_SALES_STEPS = [
  ...CUSTOMER_STEPS,
  ...PURCHASE_PIPELINE_STEPS,
  ...BILL_PAYMENT_STEPS,
];

export async function GET(
  _req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });

  try {
    await client.connect();

    // 1) Sales pipeline = qb_order_pipeline excluding customer steps (those
    //    surface under their own Customer Sync tab in the UI).
    const sales = await client.query<StatusRow>(
      `SELECT status, COUNT(*) AS count
         FROM qb_order_pipeline
        WHERE step <> ALL($1::text[])
        GROUP BY status`,
      [NON_SALES_STEPS]
    );

    // 1b) Bill Payments = the hourly read-only BillQuery per linked unpaid bill.
    //     Its own tab since 2026-07-30: at 761 rows it is the largest step in this
    //     shared table and it was drowning the sales documents next to it.
    const billPayments = await client.query<StatusRow>(
      `SELECT status, COUNT(*) AS count
         FROM qb_order_pipeline
        WHERE step = ANY($1::text[])
        GROUP BY status`,
      [[...BILL_PAYMENT_STEPS]]
    );

    // 2) Customer sync = qb_order_pipeline restricted to customer steps.
    const customers = await client.query<StatusRow>(
      `SELECT status, COUNT(*) AS count
         FROM qb_order_pipeline
        WHERE step IN (${CUSTOMER_STEPS.map((_, i) => `$${i + 1}`).join(", ")})
        GROUP BY status`,
      CUSTOMER_STEPS
    );

    // 3-6) Independent pipeline tables.
    const items = await client.query<StatusRow>(
      `SELECT status, COUNT(*) AS count FROM qb_item_pipeline
        WHERE deleted_at IS NULL GROUP BY status`
    );
    const inventory = await client.query<StatusRow>(
      `SELECT status, COUNT(*) AS count FROM qb_inventory_adjustment_pipeline
        WHERE deleted_at IS NULL GROUP BY status`
    );
    // Purchase pipeline = the same purchase-side families rendered by the
    // Purchase Pipeline tab: PO, ItemReceipt, and Vendor Bill operations.
    const purchases = await client.query<StatusRow>(
      `SELECT status, COUNT(*) AS count FROM (
         SELECT status
           FROM qb_purchase_order_pipeline
          WHERE deleted_at IS NULL
         UNION ALL
         SELECT status
           FROM qb_item_receipt_pipeline
          WHERE deleted_at IS NULL
         UNION ALL
         SELECT void_status AS status
           FROM qb_item_receipt_pipeline
          WHERE deleted_at IS NULL AND void_status IS NOT NULL
         UNION ALL
         SELECT CASE
                  WHEN intent = 'add' THEN status
                  WHEN qb_txn_id IS NOT NULL THEN 'synced'
                  ELSE status
                END AS status
           FROM qb_vendor_bill_pipeline
          WHERE deleted_at IS NULL
            AND (intent = 'add' OR qb_txn_id IS NOT NULL)
         UNION ALL
         SELECT CASE
                  WHEN status IN ('confirmed','fixed','skipped') THEN 'synced'
                  WHEN status = 'failed' AND next_retry_at IS NULL THEN 'failed_permanent'
                  WHEN status = 'failed' THEN 'error'
                  WHEN status IN ('submitted','processing') THEN 'submitted'
                  ELSE 'waiting'
                END AS status
           FROM qb_order_pipeline
          WHERE step = 'vendor_bill_mod'
         UNION ALL
         SELECT CASE WHEN void_status = 'completed' THEN 'synced'
                     ELSE void_status END AS status
           FROM qb_vendor_bill_pipeline
          WHERE deleted_at IS NULL AND void_status IS NOT NULL
       ) feed
       GROUP BY status`
    );
    const vendors = await client.query<StatusRow>(
      `SELECT status, COUNT(*) AS count FROM qb_vendor_pipeline
        WHERE deleted_at IS NULL GROUP BY status`
    );

    const build = (
      key: string,
      label: string,
      tab: string,
      rows: StatusRow[]
    ): PipelineSummary => {
      const { counts, total } = accumulate(rows);
      return { key, label, tab, counts, total };
    };

    const pipelines: PipelineSummary[] = [
      build("sales", "Sales", "operations", sales.rows),
      build("items", "Items", "items", items.rows),
      build(
        "inventory_adjustments",
        "Inventory Adjustments",
        "inventory-adjustments",
        inventory.rows
      ),
      build("purchase_orders", "Purchases", "po-pipeline", purchases.rows),
      // `tab` must match the Tabs.Trigger value in qb-pipeline/page.tsx — clicking
      // the row jumps to that tab, and a wrong value jumps nowhere.
      build("bill_payments", "Bill Payments", "bill-payments", billPayments.rows),
      build("vendors", "Vendors", "vendors", vendors.rows),
      build("customers", "Customer Sync", "customer-sync", customers.rows),
    ];

    // Totals across every pipeline (for a global rollup row).
    const totals = zeroCounts();
    let grandTotal = 0;
    for (const p of pipelines) {
      for (const b of BUCKETS) totals[b] += p.counts[b];
      grandTotal += p.total;
    }

    res.json({
      success: true,
      pipelines,
      totals: { counts: totals, total: grandTotal },
      generated_at: new Date().toISOString(),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "unknown error";
    res.status(500).json({ success: false, error: message });
  } finally {
    await client.end().catch(() => undefined);
  }
}
