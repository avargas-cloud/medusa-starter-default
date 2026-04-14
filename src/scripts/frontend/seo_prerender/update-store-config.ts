import { MedusaContainer } from "@medusajs/framework/types";
import { Modules } from "@medusajs/utils";

/**
 * Update Store Configuration
 *
 * Updates the store name and default currency to USD
 */

export default async function updateStoreConfig({
  container,
}: {
  container: MedusaContainer;
}) {
  console.log("🏪 Updating Store Configuration...\n");

  const storeService = container.resolve(Modules.STORE);

  // Get current store
  const stores = await storeService.listStores();

  if (stores.length === 0) {
    console.error("❌ No store found!");
    return;
  }

  const store = stores[0];
  console.log(`Current Store:`);
  console.log(`  Name: ${store.name}`);
  console.log(`  Default Currency: ${store.default_currency_code}`);

  console.log(`\nUpdating to:`);
  console.log(`  Name: Ecopowertech`);
  console.log(`  Default Currency: USD`);

  // Update store
  await storeService.updateStores(store.id, {
    name: "Ecopowertech",
    default_currency_code: "usd",
  });

  console.log(`\n✅ Store updated successfully!`);
  console.log(
    `📝 Note: You may need to add USD currency if it doesn't exist yet.`
  );

  return { success: true };
}
