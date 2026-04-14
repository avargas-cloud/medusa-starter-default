#!/usr/bin/env tsx
/**
 * Fix Prerender - Revert and Set Correctly
 *
 * STEP 1: Remove prerender from categories that shouldn't have it
 * STEP 2: Set prerender ONLY for:
 *   - 7 specific categories and ALL their descendants
 *   - BY CATEGORIES (only itself, NO children)
 */

import { Client } from "pg";
import dotenv from "dotenv";
dotenv.config();

const TARGET_TREES = [
  "Cables",
  "LED Controllers",
  "LED Channels",
  "LED Strips",
  "LED Drivers",
  "Backlighting",
  "Linear Lighting Accessories",
];

const STANDALONE_CATEGORIES = ["BY CATEGORIES"];

async function fixPrerender() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    await client.connect();
    console.log("✅ Connected to database\n");

    await client.query("BEGIN");

    // Get all categories
    const allCategoriesResult = await client.query(`
            SELECT id, name, parent_category_id, metadata
            FROM product_category
            WHERE deleted_at IS NULL
            ORDER BY name
        `);

    const allCategories = allCategoriesResult.rows;
    const categoryMap = new Map();
    allCategories.forEach((cat) => categoryMap.set(cat.id, cat));

    // Function to get all descendants
    function getDescendants(categoryId: string): string[] {
      const descendants: string[] = [];
      for (const cat of allCategories) {
        if (cat.parent_category_id === categoryId) {
          descendants.push(cat.id);
          descendants.push(...getDescendants(cat.id));
        }
      }
      return descendants;
    }

    // STEP 1: Find categories that SHOULD have prerender
    const shouldHavePrerender: Set<string> = new Set();

    // Add the 7 category trees (parent + all descendants)
    for (const treeName of TARGET_TREES) {
      const found = allCategories.find(
        (cat) => cat.name.toLowerCase() === treeName.toLowerCase()
      );

      if (found) {
        console.log(`📋 Tree: ${found.name}`);
        shouldHavePrerender.add(found.id);
        const descendants = getDescendants(found.id);
        descendants.forEach((id) => shouldHavePrerender.add(id));
        console.log(
          `   └─ ${descendants.length + 1} categories (parent + children)\n`
        );
      }
    }

    // Add standalone categories (ONLY themselves, NO children)
    for (const standaloneName of STANDALONE_CATEGORIES) {
      const found = allCategories.find(
        (cat) => cat.name.toLowerCase() === standaloneName.toLowerCase()
      );

      if (found) {
        console.log(`📋 Standalone: ${found.name} (no children)`);
        shouldHavePrerender.add(found.id);
        console.log("");
      }
    }

    console.log(
      `\n🎯 Categories that SHOULD have prerender: ${shouldHavePrerender.size}\n`
    );

    // STEP 2: Update all categories
    let enabledCount = 0;
    let disabledCount = 0;
    let unchangedCount = 0;

    for (const cat of allCategories) {
      const existingMetadata = cat.metadata || {};
      const currentPrerender = existingMetadata.prerender === true;
      const shouldHave = shouldHavePrerender.has(cat.id);

      if (shouldHave && !currentPrerender) {
        // Enable prerender
        const newMetadata = {
          ...existingMetadata,
          prerender: true,
        };
        await client.query(
          `
                    UPDATE product_category SET metadata = $1 WHERE id = $2
                `,
          [JSON.stringify(newMetadata), cat.id]
        );
        console.log(`✅ ENABLED: ${cat.name}`);
        enabledCount++;
      } else if (!shouldHave && currentPrerender) {
        // Disable prerender
        const newMetadata = { ...existingMetadata };
        delete newMetadata.prerender;
        await client.query(
          `
                    UPDATE product_category SET metadata = $1 WHERE id = $2
                `,
          [JSON.stringify(newMetadata), cat.id]
        );
        console.log(`❌ DISABLED: ${cat.name}`);
        disabledCount++;
      } else {
        unchangedCount++;
      }
    }

    await client.query("COMMIT");

    console.log(`\n🎉 Complete!`);
    console.log(`   ✅ Enabled: ${enabledCount}`);
    console.log(`   ❌ Disabled: ${disabledCount}`);
    console.log(`   ✓  Unchanged: ${unchangedCount}`);
    console.log(
      `\n✅ Prerender correctamente configurado en ${shouldHavePrerender.size} categorías`
    );
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("❌ Failed:", error);
    throw error;
  } finally {
    await client.end();
  }
}

fixPrerender();
