/**
 * reset-pipeline.ts
 *
 * Deletes ALL rows from qb_order_pipeline.
 * Use while debugging the QB bridge — clears stale submitted/failed entries
 * so the cron picks up fresh on the next run.
 *
 * Usage:
 *   cd backend
 *   npx ts-node -e "require('./src/scripts/reset/reset-pipeline')"
 *   -- or --
 *   yarn ts-node src/scripts/reset/reset-pipeline.ts
 */

import { Client } from "pg";
import * as readline from "readline";

async function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y");
    });
  });
}

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  // Show current state before deleting
  const { rows: counts } = await client.query(`
        SELECT status, COUNT(*) as count
        FROM qb_order_pipeline
        GROUP BY status
        ORDER BY status
    `);

  if (counts.length === 0) {
    console.log("qb_order_pipeline is already empty. Nothing to do.");
    await client.end();
    return;
  }

  console.log("\n📋 Current qb_order_pipeline contents:");
  let total = 0;
  for (const row of counts) {
    console.log(`   ${row.status.padEnd(12)} → ${row.count} rows`);
    total += parseInt(row.count, 10);
  }
  console.log(`   ${"TOTAL".padEnd(12)} → ${total} rows\n`);

  const ok = await confirm(
    `⚠️  Delete ALL ${total} rows from qb_order_pipeline? (y/N) `
  );
  if (!ok) {
    console.log("Aborted.");
    await client.end();
    return;
  }

  const { rowCount } = await client.query(`DELETE FROM qb_order_pipeline`);
  console.log(`\n✅ Deleted ${rowCount} rows from qb_order_pipeline.`);
  console.log(
    "The cron will re-enqueue eligible orders/estimates on the next run.\n"
  );

  await client.end();
}

main().catch((err) => {
  console.error("❌ Error:", err.message);
  process.exit(1);
});
