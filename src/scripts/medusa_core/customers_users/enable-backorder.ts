import { ExecArgs } from "@medusajs/framework/types";
import { Modules } from "@medusajs/utils";

/**
 * Native Medusa v2 script to enable allow_backorder on ALL inventory items.
 *
 * Run with:
 *   npx medusa exec src/scripts/enable-backorder.ts
 *
 * After this runs:
 *   - All items can be ordered regardless of stock level (admin + storefront API)
 *   - Block sold-out items on the storefront UI layer (not at the Medusa inventory layer)
 */
export default async function enableBackorder({ container }: ExecArgs) {
  const inventoryModule = container.resolve(Modules.INVENTORY) as any;

  let offset = 0;
  const limit = 100;
  let totalUpdated = 0;
  let totalSkipped = 0;

  console.log("⏳ Scanning inventory items...");

  while (true) {
    const [items, count] = await inventoryModule.listAndCountInventoryItems(
      {},
      { take: limit, skip: offset }
    );

    if (!items || items.length === 0) break;

    const toUpdate = items
      .filter((i: any) => !i.allow_backorder)
      .map((i: any) => ({ id: i.id, allow_backorder: true }));

    const alreadySet = items.length - toUpdate.length;
    totalSkipped += alreadySet;

    if (toUpdate.length > 0) {
      await inventoryModule.updateInventoryItems(toUpdate);
      totalUpdated += toUpdate.length;
      console.log(`  ✔ Updated ${toUpdate.length} items (offset ${offset})`);
    }

    offset += items.length;
    if (offset >= count) break;
  }

  console.log(`\n✅ Done!`);
  console.log(`   Updated  : ${totalUpdated} items → allow_backorder = true`);
  console.log(
    `   Skipped  : ${totalSkipped} items (already had allow_backorder = true)`
  );
  console.log(
    `   Total    : ${totalUpdated + totalSkipped} inventory items scanned`
  );
}
