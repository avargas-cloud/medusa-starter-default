import { ExecArgs } from "@medusajs/framework/types";
import WooCommerceRestApi from "@woocommerce/woocommerce-rest-api";

/**
 * Diagnose why products are being skipped during dimension sync
 * Run with: npx medusa exec ./src/scripts/diagnose-skipped-sync.ts
 */
export default async function diagnoseSkipped({ container }: ExecArgs) {
  const query = container.resolve("query");

  console.log("\n🔍 [Diagnosis] Starting skipped items check...\n");

  try {
    const WooCommerce = new WooCommerceRestApi({
      url: process.env.WC_URL!,
      consumerKey: process.env.WC_CONSUMER_KEY!,
      consumerSecret: process.env.WC_CONSUMER_SECRET!,
      version: "wc/v3",
    });

    // 1. Fetch WC Products
    console.log("📦 Fetching WooCommerce products...");
    const wcProducts: any[] = [];
    let page = 1;
    let hasMore = true;

    while (hasMore && page <= 5) {
      // Limit to 5 pages for diagnostics
      const response = await WooCommerce.get("products", {
        per_page: 100,
        page: page,
      });
      const products = response.data;
      for (const product of products) {
        if (product.sku && (product.dimensions || product.weight)) {
          wcProducts.push(product);
        }
      }
      hasMore = products.length === 100;
      page++;
    }

    console.log(`   Found ${wcProducts.length} WC products to check.`);

    // 2. Fetch Medusa Products
    const { data: medusaProducts } = await query.graph({
      entity: "product",
      fields: ["id", "title", "handle", "variants.sku", "variants.title"],
      pagination: { take: 2000 }, // Increase limit to ensure we get all
    });

    console.log(
      `   Found ${medusaProducts.length} Medusa products to check against.\n`
    );

    const missingInMedusa = [];
    const foundButNoVariantMatch = [];

    for (const wcP of wcProducts) {
      // Check if SKU exists in ANY variant of ANY Medusa product
      const exactMatch = medusaProducts.find((mP) =>
        mP.variants?.some((v: any) => v.sku === wcP.sku)
      );

      if (!exactMatch) {
        // Try to find by handle or title to see if it's just a SKU mismatch
        const potentialMatch = medusaProducts.find(
          (mP) => mP.handle === wcP.slug || mP.title === wcP.name
        );

        if (potentialMatch) {
          foundButNoVariantMatch.push({
            wc_sku: wcP.sku,
            wc_name: wcP.name,
            wc_id: wcP.id,
            medusa_handle: potentialMatch.handle,
            medusa_variants: potentialMatch.variants
              .map((v: any) => v.sku)
              .join(", "),
          });
        } else {
          missingInMedusa.push({
            sku: wcP.sku,
            name: wcP.name,
            id: wcP.id,
          });
        }
      }
    }

    console.log("============================================================");
    console.log(
      `❌ SKIPPED REPORT (${missingInMedusa.length + foundButNoVariantMatch.length} total)`
    );
    console.log(
      "============================================================\n"
    );

    if (foundButNoVariantMatch.length > 0) {
      console.log(
        `⚠ FOUND IN MEDUSA BUT SKU MISMATCH (${foundButNoVariantMatch.length}):`
      );
      console.log(
        `(The product likely exists but the SKU in Medusa is different from WC)\n`
      );
      foundButNoVariantMatch.slice(0, 20).forEach((item) => {
        console.log(`  - WC SKU: ${item.wc_sku} | WC Name: ${item.wc_name}`);
        console.log(`    -> Possible Match: ${item.medusa_handle}`);
        console.log(`    -> Medusa SKUs: ${item.medusa_variants}\n`);
      });
      if (foundButNoVariantMatch.length > 20)
        console.log(`  ... and ${foundButNoVariantMatch.length - 20} more.`);
    }

    if (missingInMedusa.length > 0) {
      console.log(
        `\n🚫 COMPLETELY MISSING IN MEDUSA (${missingInMedusa.length}):`
      );
      console.log(
        `(These SKUs were not found in any variant and no product matched by handle/title)\n`
      );
      missingInMedusa.slice(0, 20).forEach((item) => {
        console.log(`  - [${item.sku}] ${item.name}`);
      });
      if (missingInMedusa.length > 20)
        console.log(`  ... and ${missingInMedusa.length - 20} more.`);
    }

    console.log(
      "\n============================================================"
    );
  } catch (e) {
    console.error(e);
  }
}
