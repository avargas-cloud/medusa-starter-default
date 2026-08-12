/**
 * Post-commit targeted MeiliSearch update for the bulk price/cost editor —
 * same fields and docId resolution as the single-variant route
 * (`pos/prices/[productId]`), batched into ONE `updateDocuments` call.
 * Non-blocking: a failure here is a warning, never a 500 (identical to the
 * single-variant route's behavior).
 */
import { ContainerRegistrationKeys } from "@medusajs/utils";
import { WHOLESALE_PRICE_LIST_ID } from "../../../../../../lib/pos/price-write";

interface MinimalLogger {
  info: (m: string) => void;
  warn: (m: string) => void;
}

export interface MeiliBulkUpdateRow {
  variant_id: string;
  retail_price?: number;
  wholesale_price?: number;
  purchase_cost?: number;
}

export async function syncMeiliBulkPrices(
  scope: { resolve: (k: string) => unknown },
  logger: MinimalLogger,
  rows: MeiliBulkUpdateRow[]
): Promise<void> {
  if (rows.length === 0) return;

  try {
    const query = scope.resolve(ContainerRegistrationKeys.QUERY) as any;
    const variantIds = rows.map((r) => r.variant_id);

    const { data: invItems } = await query.graph({
      entity: "product_variant",
      fields: ["id", "inventory_items.inventory.id"],
      filters: { id: variantIds },
    });

    const docIdByVariant = new Map<string, string>();
    for (const v of (invItems ?? []) as any[]) {
      const invId: string | undefined = v?.inventory_items?.[0]?.inventory?.id;
      docIdByVariant.set(v.id, invId ?? v.id);
    }

    const documents = rows.map((row) => {
      const doc: Record<string, unknown> = {
        id: docIdByVariant.get(row.variant_id) ?? row.variant_id,
      };
      if (row.retail_price !== undefined) doc.price = row.retail_price;
      if (row.wholesale_price !== undefined) {
        doc.pricesByList = { [WHOLESALE_PRICE_LIST_ID]: row.wholesale_price };
      }
      if (row.purchase_cost !== undefined) doc.purchaseCost = row.purchase_cost;
      return doc;
    });

    const { MeiliSearch } = await import("meilisearch");
    const client = new MeiliSearch({
      host: process.env.MEILISEARCH_HOST!,
      apiKey: process.env.MEILISEARCH_API_KEY!,
    });

    const task = await client.index("inventory").updateDocuments(documents);
    await client.tasks.waitForTask(task.taskUid, { timeout: 8000 });
    logger.info(
      `[pos-prices-bulk] Meilisearch batch update (${documents.length} docs, taskUid: ${task.taskUid})`
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`[pos-prices-bulk] Meilisearch batch update failed (non-blocking): ${msg}`);
  }
}
