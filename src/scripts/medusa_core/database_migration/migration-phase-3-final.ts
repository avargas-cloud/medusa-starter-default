#!/usr/bin/env tsx

/**
 * PHASE 3 FINAL: Complete Migration of ALL Remaining Categories
 * Migrates all categories with handle-based IDs to Medusa ULID format
 */

import { Client } from "pg";
import { ulid } from "ulid";

async function migratePhase3() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    await client.connect();
    console.log("\n" + "=".repeat(80));
    console.log("🚀 PHASE 3 FINAL: COMPLETE CATEGORY ID MIGRATION");
    console.log("=".repeat(80) + "\n");

    // Step 1: Get all categories that need migration (IDs that don't match ULID pattern)
    const allCategories = await client.query(`
            SELECT id, name, handle, parent_category_id, metadata
            FROM product_category
            WHERE id NOT LIKE 'pcat_0%'  -- Exclude already migrated (ULID format)
            ORDER BY id
        `);

    console.log(`📊 Total categories to migrate: ${allCategories.rows.length}`);

    if (allCategories.rows.length === 0) {
      console.log("✅ All categories already migrated!\n");
      return;
    }

    // Step 2: Separate into leaf and parent categories
    const allIds = new Set(allCategories.rows.map((c) => c.id));
    const parentIds = new Set(
      allCategories.rows
        .map((c) => c.parent_category_id)
        .filter((id) => id && allIds.has(id))
    );

    const leafCategories = allCategories.rows.filter(
      (c) => !parentIds.has(c.id)
    );
    const parentCategories = allCategories.rows.filter((c) =>
      parentIds.has(c.id)
    );

    console.log(`   Leaf categories: ${leafCategories.length}`);
    console.log(`   Parent categories: ${parentCategories.length}`);

    // Step 3: Generate new IDs for all
    const idMapping: Map<string, string> = new Map();
    allCategories.rows.forEach((cat) => {
      idMapping.set(cat.id, `pcat_${ulid()}`);
    });

    console.log(`\n✨ Generated ${idMapping.size} new ULIDs`);

    // Step 4: Get product counts
    const productCounts = await client.query(
      `
            SELECT COUNT(*) as total FROM product_category_product
            WHERE product_category_id = ANY($1)
        `,
      [Array.from(allIds)]
    );

    const totalProducts = parseInt(productCounts.rows[0].total);
    console.log(`📦 Total products to update: ${totalProducts}`);

    console.log(
      "\n⚠️  CRITICAL: This will migrate ALL remaining categories in ONE transaction"
    );
    console.log("   This operation cannot be undone once committed.");
    console.log("   Press Ctrl+C within 5 seconds to abort...\n");

    await new Promise((resolve) => setTimeout(resolve, 5000));

    // Step 5: Start transaction
    console.log("🔒 Starting transaction (FK constraints deferred)...");
    await client.query("BEGIN");
    await client.query("SET CONSTRAINTS ALL DEFERRED");

    try {
      let categoriesMigrated = 0;
      let productsUpdated = 0;

      // Step 6: Migrate LEAF categories first (bottom-up)
      console.log(
        `\n📝 Phase 3a: Migrating ${leafCategories.length} leaf categories...`
      );

      for (const cat of leafCategories) {
        const oldId = cat.id;
        const newId = idMapping.get(oldId)!;

        // Update category ID
        await client.query(
          "UPDATE product_category SET id = $1 WHERE id = $2",
          [newId, oldId]
        );

        // Update product links
        const products = await client.query(
          `
                    UPDATE product_category_product
                    SET product_category_id = $1
                    WHERE product_category_id = $2
                    RETURNING product_id
                `,
          [newId, oldId]
        );

        productsUpdated += products.rows.length;
        categoriesMigrated++;

        if (categoriesMigrated % 10 === 0) {
          console.log(
            `   ✅ ${categoriesMigrated}/${leafCategories.length} leaf categories migrated`
          );
        }
      }
      console.log(
        `   ✅ All ${leafCategories.length} leaf categories migrated`
      );

      // Step 7: Migrate PARENT categories
      console.log(
        `\n📝 Phase 3b: Migrating ${parentCategories.length} parent categories...`
      );

      // Sort parents by dependency (parents of parents first)
      const sortedParents: any[] = [];
      const remaining = new Set(parentCategories);
      const processed = new Set<string>();

      while (remaining.size > 0) {
        const batch: any[] = [];
        for (const cat of Array.from(remaining)) {
          // Can process if parent is already processed or parent is already migrated (ULID format)
          const parentAlreadyMigrated =
            cat.parent_category_id && cat.parent_category_id.match(/^pcat_01/);
          const parentProcessed =
            cat.parent_category_id && processed.has(cat.parent_category_id);
          const isRoot = !cat.parent_category_id;

          if (isRoot || parentAlreadyMigrated || parentProcessed) {
            batch.push(cat);
          }
        }

        if (batch.length === 0) {
          // Circular dependency or orphans - just take remaining
          batch.push(...Array.from(remaining));
        }

        for (const cat of batch) {
          sortedParents.push(cat);
          remaining.delete(cat);
          processed.add(cat.id);
        }
      }

      let parentsMigrated = 0;
      for (const cat of sortedParents) {
        const oldId = cat.id;
        const newId = idMapping.get(oldId)!;

        // Update category ID
        await client.query(
          "UPDATE product_category SET id = $1 WHERE id = $2",
          [newId, oldId]
        );

        // Update children's parent_category_id
        await client.query(
          `
                    UPDATE product_category
                    SET parent_category_id = $1
                    WHERE parent_category_id = $2
                `,
          [newId, oldId]
        );

        // Update product links
        const products = await client.query(
          `
                    UPDATE product_category_product
                    SET product_category_id = $1
                    WHERE product_category_id = $2
                    RETURNING product_id
                `,
          [newId, oldId]
        );

        productsUpdated += products.rows.length;
        parentsMigrated++;

        if (parentsMigrated % 10 === 0) {
          console.log(
            `   ✅ ${parentsMigrated}/${parentCategories.length} parent categories migrated`
          );
        }
      }
      console.log(
        `   ✅ All ${parentCategories.length} parent categories migrated`
      );

      // Step 8: Comprehensive verification
      console.log("\n🔍 Running comprehensive verification...");

      // Verify all old IDs are gone
      const oldIds = Array.from(idMapping.keys());
      const verifyOldGone = await client.query(
        `
                SELECT id FROM product_category WHERE id = ANY($1)
            `,
        [oldIds]
      );

      if (verifyOldGone.rows.length > 0) {
        throw new Error(
          `Old IDs still exist: ${verifyOldGone.rows.map((r) => r.id).join(", ")}`
        );
      }
      console.log(`   ✅ All ${oldIds.length} old IDs removed`);

      // Verify all new IDs exist
      const newIds = Array.from(idMapping.values());
      const verifyNewExist = await client.query(
        `
                SELECT id FROM product_category WHERE id = ANY($1)
            `,
        [newIds]
      );

      if (verifyNewExist.rows.length !== idMapping.size) {
        throw new Error(
          `Expected ${idMapping.size} new IDs, found ${verifyNewExist.rows.length}`
        );
      }
      console.log(`   ✅ All ${idMapping.size} new IDs exist`);

      // Verify all IDs now follow ULID pattern
      const verifyFormat = await client.query(`
                SELECT COUNT(*) as count FROM product_category
                WHERE id NOT LIKE 'pcat_0%'
            `);

      const nonULIDCount = parseInt(verifyFormat.rows[0].count);
      if (nonULIDCount > 0) {
        throw new Error(`${nonULIDCount} categories still have non-ULID IDs`);
      }
      console.log(`   ✅ All category IDs follow ULID format`);

      // Verify parent-child relationships
      const orphanCheck = await client.query(`
                SELECT id, name FROM product_category
                WHERE parent_category_id IS NOT NULL
                AND parent_category_id NOT IN (SELECT id FROM product_category)
            `);

      if (orphanCheck.rows.length > 0) {
        throw new Error(
          `Orphaned categories found: ${orphanCheck.rows.map((r) => r.name).join(", ")}`
        );
      }
      console.log(`   ✅ No orphaned parent references`);

      // Verify product links
      const productCheck = await client.query(`
                SELECT COUNT(*) as count FROM product_category_product pcp
                LEFT JOIN product_category pc ON pcp.product_category_id = pc.id
                WHERE pc.id IS NULL
            `);

      const orphanedProducts = parseInt(productCheck.rows[0].count);
      if (orphanedProducts > 0) {
        throw new Error(
          `${orphanedProducts} products linked to non-existent categories`
        );
      }
      console.log(`   ✅ All product links valid`);
      console.log(`   ✅ ${productsUpdated} total products updated`);

      // Commit transaction
      console.log("\n✅ All verifications passed. Committing transaction...");
      await client.query("COMMIT");
      console.log("✅ Transaction committed successfully");

      // Final summary
      console.log("\n" + "=".repeat(80));
      console.log("🎉 PHASE 3 COMPLETE - ALL CATEGORIES MIGRATED");
      console.log("=".repeat(80));
      console.log(`\n📊 Final Statistics:`);
      console.log(
        `   Total categories migrated: ${categoriesMigrated + parentsMigrated}`
      );
      console.log(`   Leaf categories: ${leafCategories.length}`);
      console.log(`   Parent categories: ${parentCategories.length}`);
      console.log(`   Total products updated: ${productsUpdated}`);
      console.log(`   All IDs now in ULID format: ✅`);

      console.log(`\n📝 CRITICAL NEXT STEPS:`);
      console.log(`   1. ⚠️  Refresh admin UI (hard refresh: Ctrl+Shift+R)`);
      console.log(`   2. ⚠️  Navigate through category tree`);
      console.log(`   3. ⚠️  Verify categories appear correctly`);
      console.log(`   4. ⚠️  Check products are linked correctly`);
      console.log(`   5. ⚠️  Test storefront category pages`);
      console.log(`   6. ⚠️  Run metadata migration (Phase 4)`);
      console.log(
        `\n✅ Migration complete. Database now uses Medusa standard IDs.\n`
      );
    } catch (error) {
      console.log("\n❌ Error during migration. Rolling back...");
      await client.query("ROLLBACK");
      console.log("✅ Rollback complete. Database unchanged.");
      throw error;
    }
  } catch (error) {
    console.error("\n❌ Migration failed:", (error as Error).message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

migratePhase3();
