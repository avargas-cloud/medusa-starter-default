/**
 * Backfill the MeiliSearch `pos_invoices` index from every invoice in
 * the DB, denormalized with the linked order + customer.
 *
 * Usage:
 *   yarn medusa exec ./src/scripts/sync/sync-meili-pos-invoices.ts
 */
import type { MedusaContainer } from "@medusajs/framework/types";

import { syncAllPosInvoicesToMeili } from "../../lib/meilisearch/sync-pos-invoices-runner";

export default async function run({
  container,
}: {
  container: MedusaContainer;
}): Promise<void> {
  await syncAllPosInvoicesToMeili(container);
}
