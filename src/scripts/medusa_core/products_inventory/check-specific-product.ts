import { ExecArgs } from "@medusajs/framework/types";
import WooCommerceRestApi from "@woocommerce/woocommerce-rest-api";

/**
 * Check a specific SKU in WooCommerce to see its data
 * Run with: npx medusa exec ./src/scripts/check-specific-product.ts
 */
export default async function checkSpecificProduct({ container }: ExecArgs) {
  console.log("\n🔍 Checking LPV-100-24 in WooCommerce...\n");

  try {
    const WooCommerce = new WooCommerceRestApi({
      url: process.env.WC_URL!,
      consumerKey: process.env.WC_CONSUMER_KEY!,
      consumerSecret: process.env.WC_CONSUMER_SECRET!,
      version: "wc/v3",
    });

    // Search by SKU
    // Note: WC API doesn't allow direct get by sku easily without iterating or using `slug` depending on version
    // We will list products filtering by search or sku if supported.
    // Actually, listing with `sku` parameter works in v3.

    const response = await WooCommerce.get("products", {
      sku: "LPV-100-24",
    });

    const products = response.data;

    if (products.length === 0) {
      console.log(
        "❌ Product LPV-100-24 not found in WooCommerce via SKU search!"
      );

      // Try searching generally
      const response2 = await WooCommerce.get("products", {
        search: "LPV-100-24",
      });
      console.log(`   Genera search found ${response2.data.length} items.`);
      response2.data.forEach((p: any) =>
        console.log(`   - [${p.id}] ${p.name} (SKU: ${p.sku})`)
      );
      return;
    }

    const p = products[0];
    console.log(`✅ Found in WC: [${p.id}] ${p.name}`);
    console.log(`   Type: ${p.type}`);
    console.log(`   SKU: '${p.sku}'`);
    console.log(`   Weight: ${p.weight}`);
    console.log(`   Dimensions:`, p.dimensions);

    // Check variations if variable
    if (p.type === "variable") {
      console.log("\n   Fetching variations...");
      const vResponse = await WooCommerce.get(`products/${p.id}/variations`);
      vResponse.data.forEach((v: any) => {
        console.log(`   - Var [${v.id}] SKU: '${v.sku}'`);
        console.log(`     Weight: ${v.weight}`);
        console.log(`     Dimensions:`, v.dimensions);
      });
    }
  } catch (e) {
    console.error(e);
  }
}
