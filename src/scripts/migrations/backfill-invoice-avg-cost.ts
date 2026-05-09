/**
 * backfill-invoice-avg-cost.ts
 *
 * Populates `average_unit_cost` and `average_unit_cost_synced_at` on existing
 * `pos_invoice_item` and `pos_credit_memo_item` rows from the variant's
 * current `metadata.qb_avg_cost` / `metadata.qb_avg_cost_synced_at`.
 *
 * Limitation (acknowledged): historical rows get TODAY's avg cost, not the
 * cost-at-sale-time. QuickBooks computes avg cost cumulatively, so true
 * historical reconstruction is impossible. Forward path (Phase 3/4 wires)
 * snapshots correctly at creation; this script is the one-time best-effort
 * backfill for everything that existed before deploy.
 *
 * Idempotent: only updates rows where average_unit_cost IS NULL.
 *
 *   yarn medusa exec src/scripts/migrations/backfill-invoice-avg-cost.ts
 *   yarn medusa exec src/scripts/migrations/backfill-invoice-avg-cost.ts --apply
 *
 * Defaults to dry-run. Pass --apply to actually write.
 */

import { Client } from "pg";

type TableName = "pos_invoice_item" | "pos_credit_memo_item";

type RowToUpdate = {
  id: string;
  variant_id: string;
  qb_avg_cost: number;
  qb_avg_cost_synced_at: string | null;
};

const TABLES: TableName[] = ["pos_invoice_item", "pos_credit_memo_item"];

async function backfillTable(
  client: Client,
  table: TableName,
  apply: boolean
): Promise<{ candidates: number; updated: number; skippedNoCost: number }> {
  // Pull every row that needs cost AND has a variant_id; left-join to variant
  // so we can grab the current qb_avg_cost in the same query and avoid an
  // N+1 dance.
  const { rows } = await client.query<{
    id: string;
    variant_id: string;
    qb_avg_cost: string | null;
    qb_avg_cost_synced_at: string | null;
  }>(
    `SELECT t.id,
            t.variant_id,
            pv.metadata->>'qb_avg_cost'           AS qb_avg_cost,
            pv.metadata->>'qb_avg_cost_synced_at' AS qb_avg_cost_synced_at
       FROM ${table} t
  LEFT JOIN product_variant pv ON pv.id = t.variant_id
      WHERE t.average_unit_cost IS NULL
        AND t.variant_id IS NOT NULL`
  );

  const candidates = rows.length;
  const updates: RowToUpdate[] = [];
  let skippedNoCost = 0;

  for (const r of rows) {
    if (!r.qb_avg_cost || r.qb_avg_cost === "") {
      skippedNoCost++;
      continue;
    }
    const cost = Number(r.qb_avg_cost);
    if (!Number.isFinite(cost)) {
      skippedNoCost++;
      continue;
    }
    updates.push({
      id: r.id,
      variant_id: r.variant_id,
      qb_avg_cost: cost,
      qb_avg_cost_synced_at: r.qb_avg_cost_synced_at,
    });
  }

  if (!apply || updates.length === 0) {
    return { candidates, updated: 0, skippedNoCost };
  }

  const ids = updates.map((u) => u.id);
  const costs = updates.map((u) => u.qb_avg_cost);
  const rawCosts = updates.map((u) => JSON.stringify({ value: u.qb_avg_cost }));
  const tsList = updates.map((u) =>
    u.qb_avg_cost_synced_at ? u.qb_avg_cost_synced_at : null
  );

  const result = await client.query(
    `UPDATE ${table} AS t
        SET average_unit_cost            = u.cost::numeric,
            raw_average_unit_cost        = u.raw_cost::jsonb,
            average_unit_cost_synced_at  = u.synced_at::timestamptz,
            updated_at                   = NOW()
       FROM UNNEST($1::text[], $2::numeric[], $3::text[], $4::text[])
              AS u(id, cost, raw_cost, synced_at)
      WHERE t.id = u.id
        AND t.average_unit_cost IS NULL`,
    [ids, costs, rawCosts, tsList]
  );

  return {
    candidates,
    updated: result.rowCount ?? 0,
    skippedNoCost,
  };
}

export default async function backfillInvoiceAvgCost() {
  // medusa exec swallows extra CLI args, so accept either form:
  //   yarn medusa exec ... -- --apply              (works as raw node script)
  //   APPLY=1 yarn medusa exec ...                 (works via medusa exec)
  const apply =
    process.argv.includes("--apply") || process.env.APPLY === "1";
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }

  console.log(
    `[backfill-invoice-avg-cost] mode=${apply ? "APPLY" : "DRY-RUN"} db=${dbUrl.replace(/:[^:@]+@/, ":***@")}`
  );

  const client = new Client({ connectionString: dbUrl });
  await client.connect();

  try {
    for (const table of TABLES) {
      const t0 = Date.now();
      const stats = await backfillTable(client, table, apply);
      const elapsed = Date.now() - t0;
      console.log(
        `[${table}] candidates=${stats.candidates}  updated=${stats.updated}  skipped_no_cost=${stats.skippedNoCost}  elapsed_ms=${elapsed}`
      );
    }
  } finally {
    await client.end();
  }
}

// Allow direct invocation via `node` for one-off ops in Railway shell.
if (require.main === module) {
  backfillInvoiceAvgCost()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[backfill-invoice-avg-cost] fatal", err);
      process.exit(1);
    });
}
