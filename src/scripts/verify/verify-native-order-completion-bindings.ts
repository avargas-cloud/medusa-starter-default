/**
 * Read-only extended-protocol bindcheck for the native completion candidate
 * selector. The impossible order id guarantees zero matches and zero writes.
 *
 * Run from backend/:
 *   ./node_modules/.bin/tsx src/scripts/verify/verify-native-order-completion-bindings.ts
 */
import dotenv from "dotenv";
import { Client } from "pg";

import { listEligiblePendingOrders } from "../../lib/order-completion/eligible-orders";

dotenv.config({ path: ".env", override: true });

const NONEXISTENT_ORDER_ID = "order_00000000000000000000000000";

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required");
  }

  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    const rows = await listEligiblePendingOrders(db, {
      minAgeSeconds: 90,
      limit: 1,
      orderIds: [NONEXISTENT_ORDER_ID],
    });
    if (rows.length !== 0) {
      throw new Error(
        `impossible order id unexpectedly matched ${rows.length} row(s)`
      );
    }
    console.log("✅ native completion selector bound and executed (rows: 0)");
  } finally {
    await db.end();
  }
}

main().catch((error: unknown) => {
  console.error(`❌ ${(error as Error).message}`);
  process.exit(1);
});
