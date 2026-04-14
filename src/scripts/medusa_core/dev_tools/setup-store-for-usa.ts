import { MedusaContainer } from "@medusajs/framework/types";
import { Modules } from "@medusajs/utils";

/**
 * Setup Store for USA (Ecopowertech)
 *
 * 1. Creates USD currency
 * 2. Updates store name to "Ecopowertech"
 * 3. Sets default currency to USD
 */

export default async function setupStoreForUSA({
  container,
}: {
  container: MedusaContainer;
}) {
  console.log("🇺🇸 Setting up Store for USA (Ecopowertech)...\n");

  const storeService = container.resolve(Modules.STORE);
  const currencyService = container.resolve(Modules.CURRENCY);

  // Get current store
  const stores = await storeService.listStores();

  if (stores.length === 0) {
    console.error("❌ No store found!");
    return;
  }

  const store = stores[0];
  console.log(`📊 Current Store:`);
  console.log(`   Name: ${store.name}`);
  console.log(
    `   Default Currency: ${store.default_currency_code || "(not set)"}`
  );

  // Check if USD currency exists
  const currencies = await currencyService.listCurrencies({ code: "usd" });

  if (currencies.length === 0) {
    console.log(`\n💵 Creating USD currency...`);
    await currencyService.createCurrencies({
      code: "usd",
      symbol: "$",
      symbol_native: "$",
      name: "US Dollar",
    });
    console.log(`   ✅ USD currency created`);
  } else {
    console.log(`\n💵 USD currency already exists`);
  }

  // Update store name only
  // Currency should be set via admin UI to avoid API issues
  console.log(`\n🏪 Updating store name...`);
  await storeService.updateStores(store.id, {
    name: "Ecopowertech",
  });

  console.log(`   ✅ Store name: Ecopowertech`);

  console.log(`\n✅ Store name updated successfully!`);
  console.log(`📝 Next steps:`);
  console.log(`   1. Go to Settings → Store in admin`);
  console.log(`   2. Click "Edit" on Store settings`);
  console.log(`   3. Change "Default currency" from EUR to USD`);
  console.log(`   4. Add USD to Currencies list if not present`);
  console.log(`   5. Save changes`);

  return { success: true };
}
