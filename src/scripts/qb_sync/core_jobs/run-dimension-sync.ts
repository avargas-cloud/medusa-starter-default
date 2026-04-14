/**
 * Simple script to trigger dimension sync via HTTP
 * Run: npx tsx src/scripts/run-dimension-sync.ts
 */

async function main() {
  console.log("[Dimension Sync] Starting...\n");

  try {
    console.log("[Dimension Sync] Calling /store/sync-dimensions-temp...");

    const response = await fetch(
      "http://localhost:9000/store/sync-dimensions-temp",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const result = await response.json();

    console.log("\n✅ Sync Complete!");
    console.log("─".repeat(50));
    console.log(`WooCommerce products found: ${result.wc_products_count}`);
    console.log(`Medusa products found: ${result.medusa_products_count}`);
    console.log(`Variants matched: ${result.matched_count}`);
    console.log(`Variants updated: ${result.updated_count}`);
    console.log(`Skipped: ${result.skipped_count}`);
    console.log("─".repeat(50));

    if (result.variants && result.variants.length > 0) {
      console.log("\nSample updated variants:");
      result.variants.slice(0, 5).forEach((v: any) => {
        console.log(`  • ${v.sku}: ${v.title}`);
        console.log(
          `    ${v.dimensions.length}" x ${v.dimensions.width}" x ${v.dimensions.height}", ${v.dimensions.weight} lb`
        );
      });
    }

    process.exit(0);
  } catch (error) {
    console.error(
      "\n❌ Error:",
      error instanceof Error ? error.message : String(error)
    );
    process.exit(1);
  }
}

main();
