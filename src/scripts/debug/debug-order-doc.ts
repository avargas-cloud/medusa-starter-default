/**
 * Prints what the reindex pipeline actually produces for one order.
 *
 * Written to settle a disagreement rather than reason about it: the sandbox
 * `orders` index held effective_payment='fully_paid' with total_cents=0 for
 * #1487, a combination the classifier cannot produce (fully_paid requires
 * total > 0). Either the doc was never rewritten, or the fetch feeds the
 * classifier something different from what SQL shows. This runs the real
 * pipeline — buildAllOrderDocs, enrichment included — on that one order.
 *
 * Usage:
 *   env DATABASE_URL=... DISPLAY_ID=1487 npx medusa exec ./src/scripts/debug/debug-order-doc.ts
 */
import type { MedusaContainer } from "@medusajs/framework/types";

import { buildAllOrderDocs } from "../../lib/meilisearch/sync-orders-runner";

const TARGET = Number(process.env.DISPLAY_ID ?? 1487);

export default async function run({
  container,
}: {
  container: MedusaContainer;
}): Promise<void> {
  const pg = container.resolve("__pg_connection__") as {
    raw: (sql: string, b?: unknown[]) => Promise<{ rows: { id: string }[] }>;
  };
  const { rows } = await pg.raw(
    `SELECT id FROM "order" WHERE display_id = ? AND deleted_at IS NULL LIMIT 1`,
    [TARGET]
  );
  const orderId = rows[0]?.id;
  if (!orderId) {
    console.log(`no order with display_id ${TARGET}`);
    return;
  }

  const docs = await buildAllOrderDocs(container, undefined, [orderId]);
  const doc = docs[0];
  if (!doc) {
    console.log(`buildAllOrderDocs returned NOTHING for ${orderId} (${TARGET})`);
    console.log("=> that alone explains a stale doc: the reindex skips it.");
    return;
  }

  console.log(`--- pipeline output for #${TARGET} (${orderId}) ---`);
  console.log("  effective_payment :", doc.effective_payment);
  console.log("  is_unpaid         :", doc.is_unpaid);
  console.log("  total_cents       :", doc.total_cents);
  console.log("  status            :", doc.status);
  console.log("  is_canceled       :", doc.is_canceled);
}
