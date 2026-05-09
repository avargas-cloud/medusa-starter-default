/**
 * verify-invoice-avg-cost.ts
 *
 * Read-only sanity report for the cost snapshot fields on
 * `pos_invoice_item` and `pos_credit_memo_item`. Run after migration +
 * backfill (sandbox first, then prod) to confirm coverage and surface
 * outliers / staleness.
 *
 *   yarn medusa exec src/scripts/verify/verify-invoice-avg-cost.ts
 */

import { Client } from "pg";

type TableName = "pos_invoice_item" | "pos_credit_memo_item";
const TABLES: TableName[] = ["pos_invoice_item", "pos_credit_memo_item"];

async function reportCoverage(client: Client, table: TableName) {
  // 4 buckets: cost present (good), no variant_id (legitimate NULL — custom
  // / comment lines), variant present but qb_avg_cost missing (problematic),
  // and a margin distribution among rows that have both unit_price>0 and
  // average_unit_cost.
  const { rows } = await client.query<{
    bucket: string;
    n: string;
  }>(
    `SELECT bucket, COUNT(*)::text AS n
       FROM (
         SELECT CASE
                  WHEN average_unit_cost IS NOT NULL THEN 'with_cost'
                  WHEN variant_id IS NULL            THEN 'no_variant'
                  ELSE 'variant_no_cost'
                END AS bucket
           FROM ${table}
       ) sub
   GROUP BY bucket
   ORDER BY bucket`
  );

  const total = rows.reduce((s, r) => s + Number(r.n), 0);
  console.log(`\n── ${table} (total ${total}) ──`);
  for (const r of rows) {
    const pct = total === 0 ? 0 : (Number(r.n) / total) * 100;
    console.log(`  ${r.bucket.padEnd(18)} ${r.n.padStart(6)}  ${pct.toFixed(1)}%`);
  }
}

async function reportMarginDistribution(client: Client, table: TableName) {
  // unit_price is stored in CENTS on BOTH tables (verified via psql:
  // 6999 cents = $69.99). average_unit_cost is in DOLLARS. Normalize by
  // dividing unit_price by 100 to compare apples to apples.
  const priceExpr = "(unit_price / 100.0)";

  const { rows } = await client.query<{
    p10: string | null;
    p50: string | null;
    p90: string | null;
    n: string;
    negative_margin_rows: string;
  }>(
    `WITH eligible AS (
       SELECT ${priceExpr}::numeric AS price,
              average_unit_cost::numeric AS cost
         FROM ${table}
        WHERE average_unit_cost IS NOT NULL
          AND ${priceExpr}::numeric > 0
     )
     SELECT
       PERCENTILE_CONT(0.10) WITHIN GROUP (ORDER BY (price - cost) / price)::text AS p10,
       PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY (price - cost) / price)::text AS p50,
       PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY (price - cost) / price)::text AS p90,
       COUNT(*)::text AS n,
       COUNT(*) FILTER (WHERE cost > price)::text AS negative_margin_rows
     FROM eligible`
  );

  const r = rows[0];
  if (!r || r.n === "0") {
    console.log(`  margin: no eligible rows (no price>0 with cost)`);
    return;
  }
  const fmt = (v: string | null) =>
    v === null ? "—" : `${(Number(v) * 100).toFixed(1)}%`;
  console.log(
    `  margin: P10=${fmt(r.p10)} P50=${fmt(r.p50)} P90=${fmt(r.p90)} on n=${r.n}  (negative-margin rows: ${r.negative_margin_rows})`
  );
}

async function reportStaleness(client: Client, table: TableName) {
  const { rows } = await client.query<{
    bucket: string;
    n: string;
  }>(
    `SELECT CASE
              WHEN average_unit_cost_synced_at IS NULL                            THEN 'unknown'
              WHEN average_unit_cost_synced_at >= NOW() - INTERVAL '7 days'       THEN 'fresh_<=7d'
              WHEN average_unit_cost_synced_at >= NOW() - INTERVAL '30 days'      THEN 'fresh_<=30d'
              ELSE 'stale_>30d'
            END AS bucket,
            COUNT(*)::text AS n
       FROM ${table}
      WHERE average_unit_cost IS NOT NULL
   GROUP BY bucket
   ORDER BY bucket`
  );

  if (rows.length === 0) {
    console.log(`  staleness: no rows with cost`);
    return;
  }
  console.log(`  staleness:`);
  for (const r of rows) {
    console.log(`    ${r.bucket.padEnd(14)} ${r.n.padStart(6)}`);
  }
}

async function reportNegativeMarginSamples(client: Client, table: TableName) {
  const priceExpr = "(unit_price / 100.0)";

  const { rows } = await client.query<{
    id: string;
    invoice_or_cm: string | null;
    sku: string | null;
    quantity: string;
    price: string;
    cost: string;
  }>(
    `SELECT t.id,
            ${
              table === "pos_invoice_item"
                ? "(SELECT invoice_number FROM pos_invoice WHERE id = t.invoice_id)"
                : "(SELECT credit_memo_number FROM pos_credit_memo WHERE id = t.credit_memo_id)"
            } AS invoice_or_cm,
            t.sku,
            t.quantity::text,
            ${priceExpr}::text AS price,
            t.average_unit_cost::text AS cost
       FROM ${table} t
      WHERE t.average_unit_cost IS NOT NULL
        AND t.average_unit_cost > ${priceExpr}
   ORDER BY (t.average_unit_cost - ${priceExpr}) DESC
      LIMIT 10`
  );

  if (rows.length === 0) {
    console.log(`  negative-margin samples: none`);
    return;
  }
  console.log(`  negative-margin samples (top 10):`);
  for (const r of rows) {
    console.log(
      `    [${r.invoice_or_cm ?? "—"}] sku=${r.sku ?? "—"} qty=${r.quantity} price=${r.price} cost=${r.cost}`
    );
  }
}

export default async function verifyInvoiceAvgCost() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }

  console.log(
    `[verify-invoice-avg-cost] db=${dbUrl.replace(/:[^:@]+@/, ":***@")}`
  );

  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  try {
    for (const table of TABLES) {
      await reportCoverage(client, table);
      await reportMarginDistribution(client, table);
      await reportStaleness(client, table);
      await reportNegativeMarginSamples(client, table);
    }
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  verifyInvoiceAvgCost()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[verify-invoice-avg-cost] fatal", err);
      process.exit(1);
    });
}
