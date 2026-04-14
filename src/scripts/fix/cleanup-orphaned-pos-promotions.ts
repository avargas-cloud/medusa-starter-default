/**
 * scripts/fix/cleanup-orphaned-pos-promotions.ts
 *
 * Deletes all POS-DISC-* and CUSTOM-DISC-* promotions that are NOT
 * linked to any order. These are leftover "ghost" promotions created
 * each time a cashier applies an inline discount in the POS.
 *
 * Safe to run: only removes promotions with zero order_promotion links.
 * Promotions tied to real orders are left untouched.
 *
 * Run: npx ts-node -e "require('./src/scripts/fix/cleanup-orphaned-pos-promotions.ts')"
 * Or via: yarn ts-node src/scripts/fix/cleanup-orphaned-pos-promotions.ts
 */

import { Client } from "pg";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.join(__dirname, "../../../.env") });

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    // 1. Find orphaned promotion IDs
    const { rows: orphans } = await client.query<{ id: string; code: string }>(`
            SELECT p.id, p.code
            FROM promotion p
            LEFT JOIN order_promotion op ON op.promotion_id = p.id
            WHERE (p.code LIKE 'POS-DISC-%' OR p.code LIKE 'CUSTOM-DISC-%')
            AND op.promotion_id IS NULL
        `);

    console.log(`Found ${orphans.length} orphaned promotions to delete.`);
    if (orphans.length === 0) {
      console.log("Nothing to clean up.");
      return;
    }

    const ids = orphans.map((r) => r.id);

    // 2. Delete in cascade order (child tables first)
    await client.query("BEGIN");

    // promotion_rule_value → promotion_rule → promotion_promotion_rule
    await client.query(
      `
            DELETE FROM promotion_rule_value
            WHERE promotion_rule_id IN (
                SELECT pr.id FROM promotion_rule pr
                JOIN promotion_promotion_rule ppr ON ppr.promotion_rule_id = pr.id
                WHERE ppr.promotion_id = ANY($1)
            )
        `,
      [ids]
    );

    await client.query(
      `
            DELETE FROM promotion_rule
            WHERE id IN (
                SELECT pr.id FROM promotion_rule pr
                JOIN promotion_promotion_rule ppr ON ppr.promotion_rule_id = pr.id
                WHERE ppr.promotion_id = ANY($1)
            )
        `,
      [ids]
    );

    await client.query(
      `DELETE FROM promotion_promotion_rule WHERE promotion_id = ANY($1)`,
      [ids]
    );

    // promotion_application_method
    await client.query(
      `DELETE FROM promotion_application_method WHERE promotion_id = ANY($1)`,
      [ids]
    );

    // cart_promotion (in case any abandoned cart still references them)
    await client.query(
      `DELETE FROM cart_promotion WHERE promotion_id = ANY($1)`,
      [ids]
    );

    // finally the promotion itself
    const { rowCount } = await client.query(
      `DELETE FROM promotion WHERE id = ANY($1)`,
      [ids]
    );

    await client.query("COMMIT");

    console.log(`✓ Deleted ${rowCount} orphaned promotions.`);
    console.log("Sample deleted codes:");
    orphans.slice(0, 5).forEach((r) => console.log(`  - ${r.code}`));
    if (orphans.length > 5)
      console.log(`  ... and ${orphans.length - 5} more.`);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Error — rolled back:", err);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();
