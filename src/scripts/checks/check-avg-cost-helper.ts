/**
 * check-avg-cost-helper.ts
 *
 * Smoke test for getVariantAvgCostBatch against a real DB. Picks 5 variants
 * with cost data and prints what the helper returns. Run after migration
 * to confirm the wire-up works end-to-end.
 *
 *   yarn medusa exec ./src/scripts/checks/check-avg-cost-helper.ts
 */

import type { ExecArgs } from "@medusajs/framework/types";

import { getVariantAvgCostBatch } from "../../lib/cost/get-variant-avg-cost";

export default async function checkAvgCostHelper({ container }: ExecArgs) {
  const pgConnection = container.resolve("__pg_connection__") as {
    raw: (sql: string) => Promise<{ rows: Array<{ id: string }> }>;
  };

  const sample = await pgConnection.raw(
    `SELECT id FROM product_variant
      WHERE metadata->>'qb_avg_cost' IS NOT NULL
        AND metadata->>'qb_avg_cost' <> ''
   ORDER BY id LIMIT 5`
  );

  const ids = sample.rows.map((r) => r.id);
  console.log(`Testing helper with ${ids.length} variants:`);

  const result = await getVariantAvgCostBatch(container, ids);
  for (const [id, entry] of result.entries()) {
    console.log(
      `  ${id}  cost=${entry.cost ?? "null"}  synced_at=${
        entry.synced_at?.toISOString() ?? "null"
      }`
    );
  }

  // Also test a missing variant returns the uniform null entry
  const missing = await getVariantAvgCostBatch(container, [
    "var_does_not_exist",
    ...ids,
  ]);
  const missingEntry = missing.get("var_does_not_exist");
  console.log(
    `\nmissing-variant entry: ${
      missingEntry === undefined ? "MISSING" : JSON.stringify(missingEntry)
    }`
  );
  if (missingEntry?.cost !== null || missingEntry?.synced_at !== null) {
    throw new Error("missing-variant entry should be { cost:null, synced_at:null }");
  }
  console.log("\n✅ helper returned uniform null entry for missing variant");
}
