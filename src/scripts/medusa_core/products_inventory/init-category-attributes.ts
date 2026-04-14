#!/usr/bin/env tsx
/**
 * Initialize available_attributes for ALL categories
 *
 * Run once to fix categories that were never synced (undefined → [])
 *
 * Usage: npx tsx scripts/init-category-attributes.ts
 */

const BACKEND_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";

async function main() {
  console.log("🚀 Fetching all categories...");

  // 1. Get all categories
  const categoriesRes = await fetch(
    `${BACKEND_URL}/admin/product-categories?limit=9999&fields=%2Bmetadata`,
    {
      headers: {
        // Add your admin cookie here if running locally
        // "Cookie": "connect.sid=..."
      },
    }
  );

  if (!categoriesRes.ok) {
    throw new Error(`Failed to fetch categories: ${categoriesRes.status}`);
  }

  const { product_categories } = await categoriesRes.json();
  console.log(`   Found ${product_categories.length} categories\n`);

  // 2. Trigger sync for each category
  let synced = 0;
  let skipped = 0;
  let failed = 0;

  for (const category of product_categories) {
    const hasAvailableAttrs =
      category.metadata?.available_attributes !== undefined;

    if (hasAvailableAttrs) {
      console.log(`⏭️  ${category.name} - already synced`);
      skipped++;
      continue;
    }

    console.log(`🔄 Syncing ${category.name}...`);

    try {
      const syncRes = await fetch(
        `${BACKEND_URL}/admin/product-categories/${category.id}/sync-attributes`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            // Add cookie if needed
          },
        }
      );

      if (syncRes.ok) {
        const result = await syncRes.json();
        console.log(
          `   ✅ ${result.productCount} products, ${result.attributeCount} attributes`
        );
        synced++;
      } else {
        console.error(`   ❌ Failed: ${syncRes.status}`);
        failed++;
      }
    } catch (error: any) {
      console.error(`   ❌ Error: ${error.message}`);
      failed++;
    }

    // Small delay to avoid overwhelming the server
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  console.log(`\n📊 Summary:`);
  console.log(`   ✅ Synced: ${synced}`);
  console.log(`   ⏭️  Skipped: ${skipped}`);
  console.log(`   ❌ Failed: ${failed}`);
}

main().catch(console.error);
