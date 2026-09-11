import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework";

import { reconcileCustomerGroups } from "../lib/customers/reconcile-customer-groups";

/**
 * Converts a customer's tier signal (metadata written by the QB sync, or a
 * top-level field) into Wholesale/Retail group membership whenever the
 * customer is created or updated.
 *
 * No loop risk: `addCustomerToGroup` emits a link-table event (Medusa v2
 * uses one of several plausible names, e.g. `customer-group-customer.created`
 * / `link.created`), never `customer.updated` — confirmed by reading how
 * `customer-meilisearch-sync.ts` subscribes to those link events under
 * SEPARATE event names from `customer.updated`. So reconciling here cannot
 * re-trigger this subscriber.
 *
 * Errors are logged, not thrown — a subscriber must not crash the event bus
 * over one customer's reconciliation failing.
 */
export default async function customerGroupReconcileHandler({
  event: { data },
  container,
}: SubscriberArgs<{ id: string }>): Promise<void> {
  const logger = container.resolve("logger");
  try {
    await reconcileCustomerGroups(container, data.id);
  } catch (error) {
    logger.error(
      `[customer-group-reconcile] Failed to reconcile groups for customer ${data.id}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

export const config: SubscriberConfig = {
  event: ["customer.created", "customer.updated"],
};
