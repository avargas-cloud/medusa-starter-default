/**
 * src/scripts/sync/sync-inventory-meilisearch.ts
 *
 * Single source of truth for the `inventory` MeiliSearch index.
 * Delegates to syncInventoryWorkflow → build-inventory-docs.ts.
 * Any new fields must be added ONLY to build-inventory-docs.ts.
 *
 * Usage:
 *   yarn sync:meili:inventory   (or yarn sync:meili to run both indices)
 */

import type { MedusaContainer } from "@medusajs/framework/types";

import { syncInventoryWorkflow } from "../../workflows/sync-inventory";

export default async function run({
  container,
}: {
  container: MedusaContainer;
}): Promise<void> {
  const { result } = await syncInventoryWorkflow(container).run();
  console.log(JSON.stringify(result, null, 2));
}
