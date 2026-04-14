#!/usr/bin/env tsx
/**
 * fix-promotion-target-type.ts
 *
 * Sets target_type = 'items' on ALL promotion application_methods that still
 * have target_type = 'order'. This is the root cause of promotions computing
 * their percentage against subtotal+tax instead of the pre-tax item subtotal.
 *
 * Run:
 *   npx tsx src/scripts/fix/fix-promotion-target-type.ts
 */
import { Client } from "pg";
import dotenv from "dotenv";
dotenv.config();

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  console.log("✅ Connected to DB\n");

  // 1. Show current state
  const beforeRes = await db.query(`
        SELECT p.code, p.status, am.target_type, am.type, am.value
        FROM promotion p
        JOIN promotion_application_method am ON am.promotion_id = p.id
        WHERE p.deleted_at IS NULL AND am.deleted_at IS NULL
        ORDER BY p.created_at DESC
    `);
  console.log("Before:");
  beforeRes.rows.forEach((r) =>
    console.log(
      `  ${r.code.padEnd(25)} target_type=${r.target_type}  type=${r.type}  value=${r.value}`
    )
  );

  // 2. Fix: set target_type = 'items' for all promotions that have 'order'
  const updateRes = await db.query(`
        UPDATE promotion_application_method am
        SET target_type = 'items', updated_at = NOW()
        FROM promotion p
        WHERE am.promotion_id = p.id
          AND am.deleted_at IS NULL
          AND p.deleted_at IS NULL
          AND am.target_type = 'order'
        RETURNING p.code, am.id
    `);
  console.log(
    `\n✅ Updated ${updateRes.rowCount} promotion(s) → target_type=items`
  );
  updateRes.rows.forEach((r) => console.log(`  → ${r.code}`));

  // 3. Confirm
  const afterRes = await db.query(`
        SELECT p.code, am.target_type
        FROM promotion p
        JOIN promotion_application_method am ON am.promotion_id = p.id
        WHERE p.deleted_at IS NULL AND am.deleted_at IS NULL
        ORDER BY p.created_at DESC
    `);
  console.log("\nAfter:");
  afterRes.rows.forEach((r) =>
    console.log(`  ${r.code.padEnd(25)} target_type=${r.target_type}`)
  );

  await db.end();
  console.log(
    "\n✅ Done — now restart the backend and click Force Save on the estimate to re-apply the promotion\n"
  );
}

main().catch((e) => {
  console.error("❌", e.message);
  process.exit(1);
});
