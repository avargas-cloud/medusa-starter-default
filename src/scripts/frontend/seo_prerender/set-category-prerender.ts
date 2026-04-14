#!/usr/bin/env tsx
/**
 * Set Prerender for Category Trees
 *
 * Sets prerender:true for the following categories and ALL their descendants:
 * - Cables
 * - LED Controllers
 * - LED Channels
 * - LED Strips
 * - LED Drivers
 * - Backlighting
 * - Linear Lighting Accessories
 * - BY CATEGORIES
 */

import { Client } from "pg";
import dotenv from "dotenv";
dotenv.config();

const TARGET_CATEGORIES = [
  "Cables",
  "LED Controllers",
  "LED Channels",
  "LED Strips",
  "LED strips", // Try both capitalization
  "LED Drivers",
  "Backlighting",
  "Linear Lighting Accessories",
  "BY CATEGORIES",
];

async function setPrerenderRecursive() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    await client.connect();
    console.log("✅ Connected to database\n");

    await client.query("BEGIN");

    // Find all categories to build the tree
    const allCategoriesResult = await client.query(`
            SELECT id, name, parent_category_id, metadata
            FROM product_category
            WHERE deleted_at IS NULL
            ORDER BY name
        `);

    const allCategories = allCategoriesResult.rows;

    // Build a map for quick lookup
    const categoryMap = new Map();
    allCategories.forEach((cat) => {
      categoryMap.set(cat.id, cat);
    });

    // Function to recursively get all descendants
    function getDescendants(categoryId: string): string[] {
      const descendants: string[] = [];

      for (const cat of allCategories) {
        if (cat.parent_category_id === categoryId) {
          descendants.push(cat.id);
          // Recursively get children of this child
          descendants.push(...getDescendants(cat.id));
        }
      }

      return descendants;
    }

    // Find target categories and their descendants
    const categoriesToUpdate: Set<string> = new Set();

    for (const targetName of TARGET_CATEGORIES) {
      const found = allCategories.find(
        (cat) => cat.name.toLowerCase() === targetName.toLowerCase()
      );

      if (found) {
        console.log(`📋 Found: ${found.name} (${found.id})`);

        // Add the category itself
        categoriesToUpdate.add(found.id);

        // Add all descendants
        const descendants = getDescendants(found.id);
        descendants.forEach((id) => categoriesToUpdate.add(id));

        console.log(
          `   └─ Total in tree: ${descendants.length + 1} categories\n`
        );
      } else {
        console.log(`⚠️  Not found: ${targetName}\n`);
      }
    }

    console.log(
      `\n🎯 Total categories to update: ${categoriesToUpdate.size}\n`
    );

    // Update each category
    let updated = 0;
    for (const categoryId of categoriesToUpdate) {
      const cat = categoryMap.get(categoryId);

      const existingMetadata = cat.metadata || {};
      const newMetadata = {
        ...existingMetadata,
        prerender: true,
      };

      await client.query(
        `
                UPDATE product_category
                SET metadata = $1
                WHERE id = $2
            `,
        [JSON.stringify(newMetadata), categoryId]
      );

      const wasAlreadySet = existingMetadata.prerender === true;
      console.log(
        `${wasAlreadySet ? "✓" : "✅"} ${cat.name} ${wasAlreadySet ? "(already set)" : "(updated)"}`
      );

      updated++;
    }

    await client.query("COMMIT");

    console.log(`\n🎉 Complete!`);
    console.log(`   Updated: ${updated} categories`);
    console.log(`   All categories now have prerender: true`);
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("❌ Failed:", error);
    throw error;
  } finally {
    await client.end();
  }
}

setPrerenderRecursive();
