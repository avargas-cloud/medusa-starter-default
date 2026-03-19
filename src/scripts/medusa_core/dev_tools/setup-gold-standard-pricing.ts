import { Modules } from "@medusajs/utils";

/**
 * GOLD STANDARD Medusa v2 Pricing Setup
 * Uses native Pricing Module APIs, not direct DB manipulation
 */
export default async function ({ container }: { container: any }) {
    const pricingService = container.resolve(Modules.PRICING);
    const customerModule = container.resolve(Modules.CUSTOMER);

    console.log("🏆 Setting up GOLD STANDARD Medusa v2 Pricing\n");

    // Step 1: Get wholesale customer group
    const groups = await customerModule.listCustomerGroups({ name: "Wholesale" });
    const wholesaleGroup = groups[0];

    if (!wholesaleGroup) {
        console.log("❌ No Wholesale customer group found");
        return;
    }

    console.log("✅ Wholesale Group:", wholesaleGroup.id);

    // Step 2: Create wholesale price list using Pricing Module API
    const existingLists = await pricingService.listPriceLists({
        title: "Wholesale Pricing"
    });

    let priceList;

    if (existingLists.length > 0) {
        priceList = existingLists[0];
        console.log("✅ Using existing price list:", priceList.id);
    } else {
        priceList = await pricingService.createPriceLists({
            title: "Wholesale Pricing",
            description: "7.5% discount for wholesale customers",
            type: "sale",
            status: "active",
            rules: {
                customer_group_id: [wholesaleGroup.id]
            }
        });
        console.log("✅ Created new price list:", priceList.id);
    }

    console.log("\n🎯 Price list is now linked to Wholesale customer group via rules");
    console.log("✅ GOLD STANDARD STRUCTURE:");
    console.log("   - Base prices: retail (for everyone)");
    console.log("   - Price list: wholesale discount via customer_group rule");
    console.log("   - calculatePrices() will automatically select correct price");
}
