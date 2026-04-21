/**
 * scripts/migrations/backfill-po-numbers.ts
 *
 * One-time backfill: assigns PO-{seq} numbers to any purchase_order rows
 * that were created before the numbering code was wired into the POST route.
 *
 * Run with:
 *   npx ts-node -e "require('./src/scripts/migrations/backfill-po-numbers.ts')"
 * or via psql directly (the pure-SQL version at the bottom of this file).
 *
 * Safe to re-run: skips rows that already have a number.
 */

import * as dotenv from "dotenv";
import { Client } from "pg";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    const { rows: nullRows } = await client.query<{ id: string }>(
      `SELECT id FROM purchase_order WHERE number IS NULL AND deleted_at IS NULL ORDER BY created_at ASC`
    );

    if (nullRows.length === 0) {
      console.log("✅  All purchase orders already have numbers. Nothing to do.");
      return;
    }

    console.log(`Found ${nullRows.length} PO(s) without a number. Backfilling…`);

    for (const row of nullRows) {
      const { rows: seqRows } = await client.query<{ seq: string }>(
        `SELECT nextval('custom_purchase_order_seq') AS seq`
      );
      const seq = Number(seqRows[0].seq);
      const number = `PO-${seq}`;

      await client.query(
        `UPDATE purchase_order SET number = $1, seq = $2, updated_at = now() WHERE id = $3`,
        [number, seq, row.id]
      );

      console.log(`  ✓  ${row.id}  →  ${number}`);
    }

    console.log("✅  Backfill complete.");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
