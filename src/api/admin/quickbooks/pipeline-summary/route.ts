import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { Client } from "pg";

import {
  BILL_PAYMENT_STEPS,
  LEDGER_PIPELINE_STEPS,
  COMMISSION_PIPELINE_STEPS,
  PURCHASE_PIPELINE_STEPS,
} from "../../../../lib/quickbooks/pipeline/sales-pipeline-scope";
import {
  PIPELINE_STATUSES,
  normalizePipelineStatus,
  type PipelineFamily,
  type PipelineStatus,
} from "../../../../lib/quickbooks/pipeline-status";

/**
 * GET /admin/quickbooks/pipeline-summary
 *
 * Returns live counts for every Medusa-side QB pipeline, normalized into the
 * nine canonical pipeline-status buckets (qb-pipeline-status-vocab-20260917).
 * Every row is counted through `normalizePipelineStatus`, the same function
 * the badges use, so a raw legacy literal (sales `pending`/`confirmed`,
 * purchase `failed_permanent`/`cancelled`, log `completed`…) buckets exactly
 * where its badge would show it — no separate 5-bucket display vocabulary.
 * Drives the per-pipeline breakdown card on the QuickBooks Pipelines admin page.
 */

type Bucket = PipelineStatus;

export type PipelineSummary = {
  key: string;
  label: string;
  tab: string;
  counts: Record<Bucket, number>;
  total: number;
};

const BUCKETS: Bucket[] = [...PIPELINE_STATUSES];

const zeroCounts = (): Record<Bucket, number> =>
  Object.fromEntries(BUCKETS.map((b) => [b, 0])) as Record<Bucket, number>;

/** One row per (status, "does it carry a scheduled retry") pair, pre-grouped in SQL. */
type StatusRow = { status: string; has_retry: boolean; count: string };

/**
 * Accumulates raw rows into the canonical buckets. `family` decides which
 * legacy-literal table `normalizePipelineStatus` consults; `has_retry` is
 * the only piece of information the sales `failed` split needs, and every
 * caller below fetches it instead of a full `next_retry_at` timestamp
 * because a `COUNT(*) GROUP BY` can't carry a group of distinct instants.
 */
const accumulate = (
  family: PipelineFamily,
  rows: StatusRow[]
): { counts: Record<Bucket, number>; total: number } => {
  const counts = zeroCounts();
  let total = 0;
  for (const row of rows) {
    const normalized = normalizePipelineStatus(
      family,
      row.status,
      row.has_retry ? new Date() : null
    );
    const n = parseInt(row.count, 10) || 0;
    if ((BUCKETS as string[]).includes(normalized)) {
      counts[normalized as Bucket] += n;
    }
    total += n;
  }
  return { counts, total };
};

/** `GROUP BY status, has_retry` fragment shared by every `qb_order_pipeline` read below. */
const GROUP_BY_STATUS_RETRY =
  "GROUP BY status, (next_retry_at IS NOT NULL)";

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
  ...COMMISSION_PIPELINE_STEPS,
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
      `SELECT status, (next_retry_at IS NOT NULL) AS has_retry, COUNT(*) AS count
         FROM qb_order_pipeline
        WHERE step <> ALL($1::text[])
        ${GROUP_BY_STATUS_RETRY}`,
      [NON_SALES_STEPS]
    );

    // 1b) Ledger → QuickBooks (09/16/2026) = the documents the POS ledger sends
    //     to QuickBooks. Replaces the Bill Payments tab, whose hourly BillQuery
    //     monitor was retired once bills started being paid in the POS.
    const ledger = await client.query<StatusRow>(
      `SELECT status, (next_retry_at IS NOT NULL) AS has_retry, COUNT(*) AS count
         FROM qb_order_pipeline
        WHERE step = ANY($1::text[])
        ${GROUP_BY_STATUS_RETRY}`,
      [[...LEDGER_PIPELINE_STEPS]]
    );

    // 1c) Commissions Pipeline = el par check/payment del caso store_credit de
    //     las comisiones por orden (lane propio, ver sales-pipeline-scope.ts).
    const commissions = await client.query<StatusRow>(
      `SELECT status, (next_retry_at IS NOT NULL) AS has_retry, COUNT(*) AS count
         FROM qb_order_pipeline
        WHERE step = ANY($1::text[])
        ${GROUP_BY_STATUS_RETRY}`,
      [[...COMMISSION_PIPELINE_STEPS]]
    );

    // 2) Customer sync = qb_order_pipeline restricted to customer steps.
    const customers = await client.query<StatusRow>(
      `SELECT status, (next_retry_at IS NOT NULL) AS has_retry, COUNT(*) AS count
         FROM qb_order_pipeline
        WHERE step IN (${CUSTOMER_STEPS.map((_, i) => `$${i + 1}`).join(", ")})
        ${GROUP_BY_STATUS_RETRY}`,
      CUSTOMER_STEPS
    );

    // 3-6) Independent pipeline tables — purchase family, no retry-split ambiguity
    // (their `failed_permanent` is unconditionally terminal), so `has_retry` is
    // always false for them: never affects `normalizePipelineStatus("purchase", …)`.
    const items = await client.query<StatusRow>(
      `SELECT status, false AS has_retry, COUNT(*) AS count FROM qb_item_pipeline
        WHERE deleted_at IS NULL GROUP BY status`
    );
    const inventory = await client.query<StatusRow>(
      `SELECT status, false AS has_retry, COUNT(*) AS count FROM qb_inventory_adjustment_pipeline
        WHERE deleted_at IS NULL GROUP BY status`
    );
    // Purchase pipeline = the same purchase-side families rendered by the
    // Purchase Pipeline tab: PO, ItemReceipt, and Vendor Bill operations.
    const purchases = await client.query<StatusRow>(
      `SELECT status, false AS has_retry, COUNT(*) AS count FROM (
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
         SELECT void_status AS status
           FROM qb_vendor_bill_pipeline
          WHERE deleted_at IS NULL AND void_status IS NOT NULL
       ) feed
       GROUP BY status`
    );
    // vendor_bill_mod chain rows live in qb_order_pipeline (sales-family table,
    // per the pipeline-status vocabulary), counted separately so the retry
    // split stays correct, then merged into the "purchases" summary below.
    const purchasesModChain = await client.query<StatusRow>(
      `SELECT status, (next_retry_at IS NOT NULL) AS has_retry, COUNT(*) AS count
         FROM qb_order_pipeline
        WHERE step = 'vendor_bill_mod'
        ${GROUP_BY_STATUS_RETRY}`
    );
    const vendors = await client.query<StatusRow>(
      `SELECT status, false AS has_retry, COUNT(*) AS count FROM qb_vendor_pipeline
        WHERE deleted_at IS NULL GROUP BY status`
    );

    const build = (
      key: string,
      label: string,
      tab: string,
      family: PipelineFamily,
      rows: StatusRow[],
      extra?: { family: PipelineFamily; rows: StatusRow[] }
    ): PipelineSummary => {
      const a = accumulate(family, rows);
      if (!extra) return { key, label, tab, counts: a.counts, total: a.total };
      const b = accumulate(extra.family, extra.rows);
      const counts = zeroCounts();
      for (const bucket of BUCKETS) counts[bucket] = a.counts[bucket] + b.counts[bucket];
      return { key, label, tab, counts, total: a.total + b.total };
    };

    const pipelines: PipelineSummary[] = [
      build("sales", "Sales", "operations", "sales", sales.rows),
      build("items", "Items", "items", "purchase", items.rows),
      build(
        "inventory_adjustments",
        "Inventory Adjustments",
        "inventory-adjustments",
        "purchase",
        inventory.rows
      ),
      build("purchase_orders", "Purchases", "po-pipeline", "purchase", purchases.rows, {
        family: "sales",
        rows: purchasesModChain.rows,
      }),
      // `tab` must match the Tabs.Trigger value in qb-pipeline/page.tsx — clicking
      // the row jumps to that tab, and a wrong value jumps nowhere.
      build("ledger", "Ledger → QuickBooks", "ledger", "sales", ledger.rows),
      build("commissions", "Commissions", "commissions", "sales", commissions.rows),
      build("vendors", "Vendors", "vendors", "purchase", vendors.rows),
      build("customers", "Customer Sync", "customer-sync", "sales", customers.rows),
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
