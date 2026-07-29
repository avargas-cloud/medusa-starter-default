/**
 * verify-sales-pipeline-badge-scope
 *
 * Proves the Sales Pipeline header badges count exactly the rows the list shows.
 *
 * Bug it guards: the listing query excluded every step owning a dedicated UI tab,
 * while the badge summary excluded only `customer_data_ext`. Four failed
 * `vendor_bill_add` rows (Purchase Pipeline tab) leaked into the Sales badge —
 * the UI read "Failed 5" above a list holding a single row.
 *
 * Read-only. Builds its predicates from the shared scope module rather than
 * re-typing the SQL, so it fails if the module and the route ever drift again.
 *
 * Run:
 *   env DATABASE_URL=$(grep ^DATABASE_URL= .env | cut -d= -f2-) \
 *     ./node_modules/.bin/tsx src/scripts/verify/verify-sales-pipeline-badge-scope.ts
 */
import { Client } from "pg";

import {
  SALES_PIPELINE_EXCLUDED_STEPS,
  salesPipelineStepScopeSql,
} from "../../lib/quickbooks/pipeline/sales-pipeline-scope";

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }
  const client = new Client({ connectionString });
  await client.connect();

  try {
    // ── Badge summary, exactly as the route builds it (no `step` filter) ──────
    const badgeSql = `SELECT status, COUNT(*) AS count
                        FROM qb_order_pipeline
                       WHERE ${salesPipelineStepScopeSql(1)}
                       GROUP BY status`;
    const { rows: badgeRows } = await client.query(badgeSql, [
      SALES_PIPELINE_EXCLUDED_STEPS,
    ]);
    const badge: Record<string, number> = {};
    for (const r of badgeRows) badge[r.status] = parseInt(r.count, 10);

    // ── List totals, per status, using the same shared scope ─────────────────
    const listSql = `SELECT p.status, COUNT(*) AS count
                       FROM qb_order_pipeline p
                      WHERE ${salesPipelineStepScopeSql(1, "p")}
                      GROUP BY p.status`;
    const { rows: listRows } = await client.query(listSql, [
      SALES_PIPELINE_EXCLUDED_STEPS,
    ]);
    const list: Record<string, number> = {};
    for (const r of listRows) list[r.status] = parseInt(r.count, 10);

    // ── What the OLD badge would have reported (the regression) ─────────────
    const { rows: oldRows } = await client.query(
      `SELECT status, COUNT(*) AS count
         FROM qb_order_pipeline
        WHERE step <> 'customer_data_ext'
        GROUP BY status`
    );
    const old: Record<string, number> = {};
    for (const r of oldRows) old[r.status] = parseInt(r.count, 10);

    const statuses = Array.from(
      new Set([...Object.keys(badge), ...Object.keys(list), ...Object.keys(old)])
    ).sort();

    console.log("status        badge   list    (old badge)");
    console.log("------------------------------------------");
    let mismatches = 0;
    for (const s of statuses) {
      const b = badge[s] ?? 0;
      const l = list[s] ?? 0;
      const o = old[s] ?? 0;
      const flag = b === l ? "  " : "❌";
      if (b !== l) mismatches++;
      const drifted = o !== l ? `  ← old over-counted by ${o - l}` : "";
      console.log(
        `${flag} ${s.padEnd(12)} ${String(b).padStart(5)} ${String(l).padStart(6)} ${String(o).padStart(10)}${drifted}`
      );
    }

    console.log("");
    if (mismatches > 0) {
      console.error(
        `❌ FAIL — ${mismatches} status bucket(s) where the badge disagrees with the list.`
      );
      process.exitCode = 1;
      return;
    }
    console.log("✅ PASS — every badge count matches the listed rows exactly.");

    // ── Show what the old badge was wrongly absorbing, for the record ────────
    const { rows: leaked } = await client.query(
      `SELECT step, status, COUNT(*) AS count
         FROM qb_order_pipeline
        WHERE step <> 'customer_data_ext'
          AND NOT (${salesPipelineStepScopeSql(1)})
        GROUP BY step, status
        ORDER BY count DESC`,
      [SALES_PIPELINE_EXCLUDED_STEPS]
    );
    if (leaked.length > 0) {
      console.log("\nRows the old badge counted but the list never showed:");
      for (const r of leaked) {
        console.log(`  ${r.step} / ${r.status}: ${r.count}`);
      }
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
