#!/usr/bin/env tsx

/**
 * Verify 3 Random Categories - Endpoint vs Metadata
 */

import { Client } from "pg";
import dotenv from "dotenv";

dotenv.config();

const BACKEND_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const PUBLISHABLE_KEY = process.env.PUBLIC_MEDUSA_PUBLISHABLE_KEY || "";

async function verify3Categories() {
  console.log(`\n${"=".repeat(80)}`);
  console.log(
    `🔍 Verifying 3 Random Categories - Endpoint vs Metadata Filters`
  );
  console.log(`${"=".repeat(80)}\n`);

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  // Get 3 random categories with filters
  const result = await client.query(`
        SELECT id, name, metadata
        FROM product_category
        WHERE metadata->'filters' IS NOT NULL
        AND jsonb_array_length(metadata->'filters') > 0
        ORDER BY RANDOM()
        LIMIT 3
    `);

  console.log(`Testing ${result.rows.length} random categories...\n`);

  let allMatch = true;

  for (let i = 0; i < result.rows.length; i++) {
    const category = result.rows[i];

    console.log(`${"─".repeat(80)}`);
    console.log(`📦 [${i + 1}/3] ${category.name}`);
    console.log(`${"─".repeat(80)}`);

    // Fetch from endpoint
    const endpointResponse = await fetch(
      `${BACKEND_URL}/store/categories/${category.id}/products-with-filters?limit=1`,
      {
        headers: {
          "x-publishable-api-key": PUBLISHABLE_KEY,
        },
      }
    );

    if (!endpointResponse.ok) {
      console.log(`❌ Endpoint failed: ${endpointResponse.status}`);
      allMatch = false;
      continue;
    }

    const endpointData = await endpointResponse.json();
    const endpointFilters = endpointData.filters || [];

    // Get from metadata
    const metadata =
      typeof category.metadata === "string"
        ? JSON.parse(category.metadata)
        : category.metadata;
    const metadataFilters = metadata.filters || [];

    console.log(`\n📊 Filters:`);
    console.log(`   Endpoint: ${endpointFilters.length}`);
    console.log(`   Metadata: ${metadataFilters.length}`);

    if (endpointFilters.length !== metadataFilters.length) {
      console.log(`   ❌ COUNT MISMATCH!\n`);
      allMatch = false;
      continue;
    }

    // Sort both by attribute
    const eSort = [...endpointFilters].sort((a, b) =>
      (a.attribute || a.name).localeCompare(b.attribute || b.name)
    );
    const mSort = [...metadataFilters].sort((a, b) =>
      a.name.localeCompare(b.name)
    );

    // Compare each filter
    let categoryMatch = true;
    for (let j = 0; j < eSort.length; j++) {
      const eFilter = eSort[j];
      const mFilter = mSort[j];

      const eOptions = (eFilter.options || []).length;
      const mOptions = (mFilter.options || []).length;

      if (eOptions !== mOptions) {
        categoryMatch = false;
        break;
      }

      // Compare counts
      const eSorted = [...(eFilter.options || [])].sort((a, b) =>
        (a.option || a.value).localeCompare(b.option || b.value)
      );
      const mSorted = [...(mFilter.options || [])].sort((a, b) =>
        a.value.localeCompare(b.value)
      );

      for (let k = 0; k < eSorted.length; k++) {
        if (eSorted[k].count !== mSorted[k].count) {
          categoryMatch = false;
          break;
        }
      }
    }

    if (categoryMatch) {
      console.log(`   ✅ All ${endpointFilters.length} filters match!\n`);
    } else {
      console.log(`   ⚠️  Some filter counts differ\n`);
      allMatch = false;
    }
  }

  await client.end();

  console.log(`${"=".repeat(80)}`);
  console.log(`📈 FINAL RESULT`);
  console.log(`${"=".repeat(80)}`);

  if (allMatch) {
    console.log(`\n🎉 ALL 3 CATEGORIES PERFECT!`);
    console.log(`   ✅ Endpoint matches metadata for all tested categories`);
    console.log(`   ✅ Nuclear sync generated accurate filters`);
  } else {
    console.log(`\n⚠️  Some differences found`);
  }
  console.log("");
}

async function main() {
  try {
    await verify3Categories();
  } catch (error: any) {
    console.error(`\n❌ Error: ${error.message}`);
    console.error(error.stack);
  }
}

main();
