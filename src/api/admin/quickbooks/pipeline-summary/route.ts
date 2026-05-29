import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { Client } from "pg";

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

const accumulate = (rows: StatusRow[]): { counts: Record<Bucket, number>; total: number } => {
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

const CUSTOMER_STEPS = ["customer", "customer_data_ext"];

export async function GET(_req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });

  try {
    await client.connect();

    // 1) Sales pipeline = qb_order_pipeline excluding customer steps (those
    //    surface under their own Customer Sync tab in the UI).
    const sales = await client.query<StatusRow>(
      `SELECT status, COUNT(*) AS count
         FROM qb_order_pipeline
        WHERE step NOT IN (${CUSTOMER_STEPS.map((_, i) => `$${i + 1}`).join(", ")})
        GROUP BY status`,
      CUSTOMER_STEPS
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
    // Purchase pipeline = the SAME three-source union the "Purchase Pipeline"
    // tab renders (see admin/purchase-orders/qb-pipeline/route.ts): PO rows +
    // ItemReceipt add (status) + ItemReceipt void/delete (void_status, only
    // when the void lifecycle has started). Counting only the PO table here
    // undercounted — ItemReceipt errors never reached the breakdown.
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
