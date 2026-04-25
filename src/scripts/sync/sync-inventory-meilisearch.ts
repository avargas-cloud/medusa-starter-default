/**
 * src/scripts/sync/sync-inventory-meilisearch.ts
 *
 * Manual trigger: runs syncInventoryWorkflow once.
 *
 * Usage:
 *   npx medusa exec ./src/scripts/sync/sync-inventory-meilisearch.ts
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
