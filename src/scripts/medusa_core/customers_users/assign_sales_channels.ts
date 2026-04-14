/**
 * assign_sales_channels.ts
 *
 * Assigns ALL active sales channels to products that currently have none.
 * Run dry run first, then --apply.
 *
 * USAGE:
 *   cd backend && npx tsx src/scripts/assign_sales_channels.ts
 *   cd backend && npx tsx src/scripts/assign_sales_channels.ts --apply
 */

import { Client } from "pg";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const DRY_RUN = !process.argv.includes("--apply");

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  console.log("✅ Connected\n");
  console.log(DRY_RUN ? "🔍 DRY RUN\n" : "⚡ APPLY MODE\n");

  // Get all sales channels
  const scRes = await client.query<{ id: string; name: string }>(
    "SELECT id, name FROM sales_channel WHERE deleted_at IS NULL ORDER BY name"
  );
  const channels = scRes.rows;
  console.log("Sales channels:");
  for (const sc of channels) console.log(`  [${sc.id}] ${sc.name}`);
  console.log();

  // Find products with NO sales channel assigned
  const prodRes = await client.query<{ id: string; title: string }>(`
        SELECT p.id, p.title
        FROM product p
        WHERE p.deleted_at IS NULL
          AND NOT EXISTS (
              SELECT 1 FROM product_sales_channel psc WHERE psc.product_id = p.id
          )
        ORDER BY p.title
    `);
  const products = prodRes.rows;
  console.log(`Products with no sales channel (${products.length}):`);
  for (const p of products) console.log(`  ${p.id} | ${p.title}`);
  console.log();

  if (DRY_RUN) {
    console.log(
      `→ Would assign ${channels.length} channels to ${products.length} products`
    );
    console.log("\nMode: DRY RUN (pass --apply to save)\n");
    await client.end();
    return;
  }

  let assigned = 0;
  for (const p of products) {
    for (const sc of channels) {
      await client.query(
        "INSERT INTO product_sales_channel (id, product_id, sales_channel_id, created_at, updated_at) VALUES (gen_random_uuid(), $1, $2, NOW(), NOW()) ON CONFLICT DO NOTHING",
        [p.id, sc.id]
      );
      assigned++;
    }
    console.log(`✅ ${p.title} → ${channels.map((c) => c.name).join(", ")}`);
  }

  console.log(`\n── Summary ──────────────────────────────`);
  console.log(`  Products updated : ${products.length}`);
  console.log(`  Assignments made : ${assigned}`);
  console.log(`  Mode             : APPLIED ✅`);
  console.log(`─────────────────────────────────────────\n`);

  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
