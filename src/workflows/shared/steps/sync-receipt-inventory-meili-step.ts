import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk";
import { syncInventoryItemToMeiliSearchWorkflow } from "../../sync-inventory-item-meilisearch";

/**
 * Final step for receive/delete-receipt workflows.
 * Syncs each affected inventory_item_id to the MeiliSearch `inventory` index
 * after stock levels change. Errors are caught per-item so a Meili outage
 * never rolls back a completed receipt.
 */
export const syncReceiptInventoryMeiliStep = createStep(
  "sync-receipt-inventory-to-meili",
  async (
    input: { inventory_item_ids: string[] },
    { container }
  ) => {
    const logger = container.resolve("logger") as {
      info: (m: string) => void;
      warn: (m: string) => void;
    };

    const results = await Promise.allSettled(
      input.inventory_item_ids.map((inventoryItemId) =>
        syncInventoryItemToMeiliSearchWorkflow(container).run({
          input: { inventoryItemId },
        })
      )
    );

    const failed = results.filter((r) => r.status === "rejected");
    if (failed.length > 0) {
      failed.forEach((r) => {
        const reason = (r as PromiseRejectedResult).reason;
        logger.warn(
          `[syncReceiptInventoryMeili] Meili sync failed for one item: ${reason?.message ?? reason}`
        );
      });
    }

    const synced = results.length - failed.length;
    logger.info(
      `[syncReceiptInventoryMeili] ✅ ${synced}/${results.length} inventory items synced to Meili`
    );

    return new StepResponse({ synced, failed: failed.length });
  }
);
