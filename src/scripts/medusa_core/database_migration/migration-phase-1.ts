#!/usr/bin/env tsx

/**
 * PHASE 1: Single Category Migration Test
 * Strategy: Use DEFERRED constraints to allow direct UPDATE of ID column
 */

import { Client } from "pg";
import { ulid } from "ulid";

async function migratePhase1() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    await client.connect();
    console.log('\n🚀 PHASE 1: Migrating "Cables" category\n');

    // Step 1: Get category info
    const categoryResult = await client.query(`
            SELECT id, name, handle, parent_category_id, metadata
            FROM product_category
            WHERE id = 'pcat_cables'
        `);

    if (categoryResult.rows.length === 0) {
      throw new Error('Category "Cables" not found');
    }

    const oldCategory = categoryResult.rows[0];
    console.log("📦 Old Category:");
    console.log(`   Name: ${oldCategory.name}`);
    console.log(`   Old ID: ${oldCategory.id}`);

    // Step 2: Get children
    const childrenResult = await client.query(
      `
            SELECT id, name FROM product_category
            WHERE parent_category_id = $1
        `,
      [oldCategory.id]
    );

    console.log(`\n👶 Children (${childrenResult.rows.length}):`);
    childrenResult.rows.forEach((child) => {
      console.log(`   - ${child.name} (${child.id})`);
    });

    // Step 3: Generate new ID
    const newId = `pcat_${ulid()}`;
    console.log(`\n✨ New ID: ${newId}`);

    // Step 4: Start transaction with DEFERRED FK constraints
    console.log("\n🔒 Starting transaction (FK constraints deferred)...");
    await client.query("BEGIN");
    await client.query("SET CONSTRAINTS ALL DEFERRED");

    try {
      // Step 5: Update category ID directly
      console.log("📝 Updating category ID from old to new...");
      const updateResult = await client.query(
        `
                UPDATE product_category
                SET id = $1
                WHERE id = $2
                RETURNING id, name
            `,
        [newId, oldCategory.id]
      );
      console.log(`   ✅ Updated category ID`);

      // Step 6: Update children's parent_category_id
      console.log("📝 Updating children parent_category_id...");
      const updateChildren = await client.query(
        `
                UPDATE product_category
                SET parent_category_id = $1
                WHERE parent_category_id = $2
                RETURNING id, name
            `,
        [newId, oldCategory.id]
      );
      console.log(`   ✅ Updated ${updateChildren.rows.length} children`);

      // Step 7: Update product links
      console.log("📝 Updating product links...");
      const updateProducts = await client.query(
        `
                UPDATE product_category_product
                SET product_category_id = $1
                WHERE product_category_id = $2
                RETURNING product_id
            `,
        [newId, oldCategory.id]
      );
      console.log(`   ✅ Updated ${updateProducts.rows.length} product links`);

      // Step 8: Verify integrity
      console.log("\n🔍 Verifying integrity...");

      // Check children
      const verifyChildren = await client.query(
        `
                SELECT COUNT(*) as count
                FROM product_category
                WHERE parent_category_id = $1
            `,
        [newId]
      );
      const childCount = parseInt(verifyChildren.rows[0].count);
      console.log(`   Children with new parent ID: ${childCount}`);

      if (childCount !== childrenResult.rows.length) {
        throw new Error(
          `Child count mismatch! Expected ${childrenResult.rows.length}, got ${childCount}`
        );
      }

      // Check old ID gone
      const verifyOldGone = await client.query(
        `
                SELECT COUNT(*) as count FROM product_category WHERE id = $1
            `,
        [oldCategory.id]
      );

      if (parseInt(verifyOldGone.rows[0].count) > 0) {
        throw new Error("Old ID still exists!");
      }
      console.log(`   ✅ Old ID removed`);

      // Check new ID exists
      const verifyNewExists = await client.query(
        `
                SELECT id, name FROM product_category WHERE id = $1
            `,
        [newId]
      );

      if (verifyNewExists.rows.length === 0) {
        throw new Error("New ID not found!");
      }
      console.log(`   ✅ New ID exists: ${verifyNewExists.rows[0].name}`);

      // Commit transaction (FK constraints checked now)
      console.log("\n✅ All checks passed. Committing transaction...");
      await client.query("COMMIT");
      console.log("✅ Transaction committed (FK constraints verified)");

      // Final summary
      console.log("\n" + "=".repeat(80));
      console.log("✅ PHASE 1 MIGRATION SUCCESSFUL");
      console.log("=".repeat(80));
      console.log(`\n📊 Summary:`);
      console.log(`   Category: ${oldCategory.name}`);
      console.log(`   Old ID: ${oldCategory.id}`);
      console.log(`   New ID: ${newId}`);
      console.log(`   Children updated: ${childrenResult.rows.length}`);
      console.log(`   Product links updated: ${updateProducts.rows.length}`);
      console.log(`\n📝 Action Required:`);
      console.log(`   1. Refresh admin UI`);
      console.log(`   2. Navigate to "Cables" category`);
      console.log(`   3. Verify it appears correctly`);
      console.log(`   4. Verify 3 child categories still visible`);
      console.log(`   5. Check category tree structure`);
      console.log(
        `\n✅ If verification passes, ready for Phase 2 (10 categories)\n`
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

migratePhase1();
