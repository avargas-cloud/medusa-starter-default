#!/usr/bin/env tsx

/**
 * Compare Filters: Endpoint vs Metadata
 *
 * Compara los filtros del endpoint combinado contra metadata.filters
 * (Asume que Nuclear Sync ya se ejecutó previamente)
 */

const BACKEND_URL = "http://localhost:9000";
const LED_STRIPS_ID = "pcat_01KGAD1KQXDWJEP7HE92G5FCS4";

async function compareFilters() {
  console.log(`\n${"=".repeat(80)}`);
  console.log(`🔍 Comparando Filtros: LED Strips`);
  console.log(`   Endpoint vs Metadata`);
  console.log(`${"=".repeat(80)}`);

  try {
    // 1. Fetch from combined endpoint
    console.log(`\n📡 1. Fetching from COMBINED ENDPOINT...`);
    console.log(
      `   URL: /store/categories/${LED_STRIPS_ID}/products-with-filters`
    );

    const combinedResponse = await fetch(
      `${BACKEND_URL}/store/categories/${LED_STRIPS_ID}/products-with-filters?limit=1`
    );

    if (!combinedResponse.ok) {
      console.error(`❌ Combined endpoint failed: ${combinedResponse.status}`);
      return;
    }

    const combinedData = await combinedResponse.json();
    const endpointFilters = combinedData.filters || [];

    console.log(`   ✅ Filters from endpoint: ${endpointFilters.length}`);
    console.log(`   ✅ Products: ${combinedData.pagination.total}`);

    // 2. Fetch category metadata directly
    console.log(`\n📦 2. Fetching from CATEGORY METADATA...`);
    console.log(`   URL: /store/categories/${LED_STRIPS_ID}`);

    const categoryResponse = await fetch(
      `${BACKEND_URL}/store/categories/${LED_STRIPS_ID}`
    );

    if (!categoryResponse.ok) {
      console.error(`❌ Category fetch failed: ${categoryResponse.status}`);
      return;
    }

    const categoryData = await categoryResponse.json();
    const metadataFilters =
      categoryData.product_category?.metadata?.filters || [];
    const includeDescendants =
      categoryData.product_category?.metadata?.include_descendants_tree ?? true;

    console.log(`   ✅ Filters from metadata: ${metadataFilters.length}`);
    console.log(`   ✅ include_descendants_tree: ${includeDescendants}`);

    // 3. Compare counts
    console.log(`\n🔄 3. COMPARISON RESULTS`);
    console.log(`${"=".repeat(80)}`);

    if (endpointFilters.length !== metadataFilters.length) {
      console.log(`\n❌ COUNT MISMATCH!`);
      console.log(`   Endpoint: ${endpointFilters.length}`);
      console.log(`   Metadata: ${metadataFilters.length}`);
      console.log(`\n   ⚠️  This indicates the data sources are out of sync!`);
      return;
    } else {
      console.log(`\n✅ Filter Count: ${endpointFilters.length} (MATCH)`);
    }

    // 4. Compare each filter
    console.log(`\n📊 Filter-by-Filter Comparison:\n`);

    let perfectMatches = 0;
    let mismatches = 0;

    for (let i = 0; i < endpointFilters.length; i++) {
      const endpointFilter = endpointFilters[i];
      const metadataFilter = metadataFilters[i];

      // Compare basic properties
      const idMatch = endpointFilter.id === metadataFilter.id;
      const nameMatch = endpointFilter.name === metadataFilter.name;
      const typeMatch =
        endpointFilter.filter_type === metadataFilter.filter_type;

      if (!idMatch || !nameMatch || !typeMatch) {
        console.log(`❌ Filter ${i + 1}: Basic properties mismatch`);
        console.log(`   Endpoint: ${endpointFilter.name}`);
        console.log(`   Metadata: ${metadataFilter.name}`);
        mismatches++;
        continue;
      }

      // Compare options
      const endpointOptions = endpointFilter.options || [];
      const metadataOptions = metadataFilter.options || [];

      if (endpointOptions.length !== metadataOptions.length) {
        console.log(`⚠️  Filter ${i + 1}: ${endpointFilter.name}`);
        console.log(
          `   Options count: Endpoint(${endpointOptions.length}) vs Metadata(${metadataOptions.length})`
        );
        mismatches++;
        continue;
      }

      // Deep compare options
      let allOptionsMatch = true;
      for (let j = 0; j < endpointOptions.length; j++) {
        const eOpt = endpointOptions[j];
        const mOpt = metadataOptions[j];

        if (eOpt.value !== mOpt.value || eOpt.count !== mOpt.count) {
          allOptionsMatch = false;
          break;
        }
      }

      if (allOptionsMatch) {
        console.log(
          `✅ Filter ${i + 1}: ${endpointFilter.display_name || endpointFilter.name} (${endpointOptions.length} options)`
        );
        perfectMatches++;
      } else {
        console.log(
          `⚠️  Filter ${i + 1}: ${endpointFilter.name} - Option values/counts differ`
        );
        mismatches++;
      }
    }

    // 5. Final summary
    console.log(`\n${"=".repeat(80)}`);
    console.log(`📈 FINAL RESULTS`);
    console.log(`${"=".repeat(80)}`);
    console.log(
      `✅ Perfect Matches: ${perfectMatches}/${endpointFilters.length}`
    );
    console.log(`⚠️  Mismatches: ${mismatches}/${endpointFilters.length}`);

    if (mismatches === 0) {
      console.log(`\n🎉 ALL FILTERS MATCH PERFECTLY!`);
      console.log(`   The endpoint and metadata are in perfect sync.`);
    } else {
      console.log(`\n⚠️  Some filters don't match.`);
      console.log(`   This may indicate:`);
      console.log(`   - Nuclear sync hasn't been run recently`);
      console.log(`   - Products changed after last sync`);
      console.log(
        `   - Logic differences between endpoint and metadata generation`
      );
    }

    // 6. Show first filter as example
    console.log(`\n📄 Sample Comparison (First Filter):`);
    console.log(`\nFrom Endpoint:`);
    console.log(
      JSON.stringify(endpointFilters[0], null, 2).substring(0, 500) + "..."
    );
    console.log(`\nFrom Metadata:`);
    console.log(
      JSON.stringify(metadataFilters[0], null, 2).substring(0, 500) + "..."
    );
  } catch (error: any) {
    console.error(`❌ Comparison failed: ${error.message}`);
    console.error(error.stack);
  }
}

async function main() {
  console.log(`\n🧪 Filter Comparison Test`);
  console.log(`   (Make sure Nuclear Sync was run from Admin UI first!)\n`);

  await compareFilters();

  console.log(`\n✅ Comparison completed!\n`);
}

main().catch(console.error);
