import type { MedusaContainer } from "@medusajs/framework/types";

import { ORDERS_INDEX, buildAllOrderDocs } from "../../lib/meilisearch/sync-orders-runner";

/**
 * Rebuilds the Meili document for named orders from the database.
 *
 * For a doc the 5-minute reconciler can no longer reach: its sweep only looks at
 * rows touched in the last 6 minutes, so an order that stops moving keeps a wrong
 * document forever. S11417 sat indexed as `delivered` (10 of 42 units actually
 * delivered) from 2026-08-11 until this ran — out of the Open Orders tab, which
 * is why a second order was typed for the same 32 units.
 *
 * Writes only to MeiliSearch, and only values recomputed from Postgres. Touches
 * no order, no reservation, no money. Dry-run unless APPLY=true.
 *
 *   npx medusa exec ./src/scripts/fix/reindex-orders-by-id.ts <order_id…>
 */
export default async function reindexOrdersById({
  container,
  args,
}: {
  container: MedusaContainer;
  args: string[];
}) {
  const ids = (args ?? []).filter((a) => a.startsWith("order_"));
  if (ids.length === 0) {
    console.log("usage: … reindex-orders-by-id.ts <order_id> [order_id…]");
    return;
  }

  const apply = process.env.APPLY === "true";
  const silent = { info: () => {}, warn: () => {}, error: () => {} };

  const docs = (await buildAllOrderDocs(
    container,
    silent,
    ids
  )) as unknown as Array<Record<string, unknown>>;

  const { MeiliSearch } = await import("meilisearch");
  const index = new MeiliSearch({
    host: process.env.MEILISEARCH_HOST!,
    apiKey: process.env.MEILISEARCH_API_KEY!,
  }).index(ORDERS_INDEX);

  const WATCH = [
    "status",
    "fulfillment_status",
    "is_open",
    "is_closed",
    "effective_payment",
  ] as const;

  for (const doc of docs) {
    const id = String(doc.id);
    let current: Record<string, unknown> | null = null;
    try {
      current = (await index.getDocument(id)) as Record<string, unknown>;
    } catch {
      current = null;
    }

    const changes = WATCH.filter(
      (f) => JSON.stringify(current?.[f]) !== JSON.stringify(doc[f])
    ).map((f) => `${f}: ${String(current?.[f])} → ${String(doc[f])}`);

    console.log(
      `${doc.document_number ?? id}: ${
        changes.length === 0 ? "already correct" : changes.join(" | ")
      }`
    );
  }

  if (!apply) {
    console.log(`\nDRY RUN — ${docs.length} doc(s) NOT written. APPLY=true to write.`);
    return;
  }

  await index.updateDocuments(docs, { primaryKey: "id" });
  console.log(`\nAPPLIED — ${docs.length} doc(s) upserted into "${ORDERS_INDEX}".`);
}
