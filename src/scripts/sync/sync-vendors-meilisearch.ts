/**
 * src/scripts/sync/sync-vendors-meilisearch.ts
 *
 * Manual trigger: runs syncVendorsToMeiliWorkflow once.
 *
 * Usage:
 *   npx medusa exec ./src/scripts/sync/sync-vendors-meilisearch.ts
 */

import type { MedusaContainer } from "@medusajs/framework/types";

import { syncVendorsToMeiliWorkflow } from "../../workflows/sync-vendors-meilisearch";

export default async function run({
  container,
}: {
  container: MedusaContainer;
}): Promise<void> {
  const { result } = await syncVendorsToMeiliWorkflow(container).run();
  console.log(JSON.stringify(result, null, 2));
}
