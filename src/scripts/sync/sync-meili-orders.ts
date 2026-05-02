/**
 * Backfill the MeiliSearch `orders` index from every order in the DB.
 * Thin CLI wrapper around lib/meilisearch/sync-orders-runner.
 *
 * Usage:
 *   yarn medusa exec ./src/scripts/sync/sync-meili-orders.ts
 */
import type { MedusaContainer } from "@medusajs/framework/types";

import { syncAllOrdersToMeili } from "../../lib/meilisearch/sync-orders-runner";

export default async function run({
  container,
}: {
  container: MedusaContainer;
}): Promise<void> {
  await syncAllOrdersToMeili(container);
}
