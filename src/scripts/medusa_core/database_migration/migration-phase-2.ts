#!/usr/bin/env tsx

/**
 * PHASE 2: Migrate complete category tree - Ceiling Lights
 * Strategy: Bottom-up (children first, then parent)
 */

import { Client } from "pg";
import { ulid } from "ulid";

async function migratePhase2() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    await client.connect();
    console.log('\n🚀 PHASE 2: Migrating "Ceiling Lights" complete tree\n');

    // Step 1: Get parent category
    const parentResult = await client.query(`
            SELECT id, name, handle FROM product_category
            WHERE handle = 'ceiling-lights'
        `);

    if (parentResult.rows.length === 0) {
      throw new Error("Ceiling Lights not found");
    }

    const parent = parentResult.rows[0];
    console.log("📦 Parent: " + parent.name);

    // Step 2: Get all children
    const childrenResult = await client.query(
      `
            SELECT id, name, handle FROM product_category
            WHERE parent_category_id = $1
            ORDER BY name
        `,
      [parent.id]
    );

    console.log(`👶 Children: ${childrenResult.rows.length}`);
    childrenResult.rows.forEach((c) => console.log(`   - ${c.name}`));

    // Step 3: Generate new IDs for all
    const idMapping: Map<string, string> = new Map();

    // Generate for children first
    childrenResult.rows.forEach((child) => {
      idMapping.set(child.id, `pcat_${ulid()}`);
    });

    // Then for parent
    idMapping.set(parent.id, `pcat_${ulid()}`);

    console.log(`\n✨ Generated ${idMapping.size} new IDs`);

    // Step 4: Start transaction
    console.log("\n🔒 Starting transaction (FK constraints deferred)...");
    await client.query("BEGIN");
    await client.query("SET CONSTRAINTS ALL DEFERRED");

    try {
      let totalProductsUpdated = 0;

      // Step 5: Migrate CHILDREN first (bottom-up)
      console.log("\n📝 Phase 2a: Migrating children...");
      for (const child of childrenResult.rows) {
        const oldId = child.id;
        const newId = idMapping.get(oldId)!;

        console.log(`\n   Processing: ${child.name}`);
        console.log(`   ${oldId} → ${newId}`);

        // Update category ID
        await client.query(
          `
                    UPDATE product_category SET id = $1 WHERE id = $2
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

        const productCount = products.rows.length;
        totalProductsUpdated += productCount;
        console.log(`   ✅ ${productCount} products`);
      }
      console.log(
        `\n   ✅ All children migrated (${childrenResult.rows.length} categories)`
      );

      // Step 6: Migrate PARENT
      console.log(`\n📝 Phase 2b: Migrating parent...`);
      const oldParentId = parent.id;
      const newParentId = idMapping.get(oldParentId)!;

      console.log(`\n   Processing: ${parent.name}`);
      console.log(`   ${oldParentId} → ${newParentId}`);

      // Update parent category ID
      await client.query(
        `
                UPDATE product_category SET id = $1 WHERE id = $2
            `,
        [newParentId, oldParentId]
      );

      // Update children's parent_category_id to point to new parent ID
      const childrenUpdated = await client.query(
        `
                UPDATE product_category
                SET parent_category_id = $1
                WHERE parent_category_id = $2
                RETURNING id, name
            `,
        [newParentId, oldParentId]
      );

      console.log(
        `   ✅ ${childrenUpdated.rows.length} children re-linked to new parent ID`
      );

      // Update parent's own product links
      const parentProducts = await client.query(
        `
                UPDATE product_category_product
                SET product_category_id = $1
                WHERE product_category_id = $2
                RETURNING product_id
            `,
        [newParentId, oldParentId]
      );

      const parentProductCount = parentProducts.rows.length;
      totalProductsUpdated += parentProductCount;
      console.log(`   ✅ ${parentProductCount} products`);

      // Step 7: Verify integrity
      console.log("\n🔍 Verifying integrity...");

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
      console.log(`   ✅ All old IDs removed`);

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

      // Verify parent-child relationships
      const verifyChildren = await client.query(
        `
                SELECT COUNT(*) as count FROM product_category
                WHERE parent_category_id = $1
            `,
        [newParentId]
      );

      const childCount = parseInt(verifyChildren.rows[0].count);
      if (childCount !== childrenResult.rows.length) {
        throw new Error(
          `Expected ${childrenResult.rows.length} children, found ${childCount}`
        );
      }
      console.log(`   ✅ ${childCount} children linked to parent`);

      // Verify product count
      const verifyProducts = await client.query(
        `
                SELECT COUNT(*) as count FROM product_category_product
                WHERE product_category_id = ANY($1)
            `,
        [newIds]
      );

      const totalProducts = parseInt(verifyProducts.rows[0].count);
      console.log(`   ✅ ${totalProducts} total products linked`);

      // Commit transaction
      console.log("\n✅ All checks passed. Committing transaction...");
      await client.query("COMMIT");
      console.log("✅ Transaction committed");

      // Final summary
      console.log("\n" + "=".repeat(80));
      console.log("✅ PHASE 2 MIGRATION SUCCESSFUL");
      console.log("=".repeat(80));
      console.log(`\n📊 Summary:`);
      console.log(`   Parent: ${parent.name}`);
      console.log(`   Children: ${childrenResult.rows.length}`);
      console.log(`   Total categories migrated: ${idMapping.size}`);
      console.log(`   Total products updated: ${totalProducts}`);

      console.log(`\n📝 ID Mapping:`);
      console.log(`   ${parent.name}:`);
      console.log(`      ${parent.id} → ${newParentId}`);
      childrenResult.rows.forEach((child) => {
        console.log(`   ${child.name}:`);
        console.log(`      ${child.id} → ${idMapping.get(child.id)}`);
      });

      console.log(`\n📝 Action Required:`);
      console.log(`   1. Refresh admin UI`);
      console.log(`   2. Navigate to "Ceiling Lights"`);
      console.log(`   3. Verify parent + all children appear`);
      console.log(`   4. Check products still linked correctly`);
      console.log(`   5. Test navigation and product pages`);
      console.log(
        `\n✅ If verification passes, ready for FULL migration (all categories)\n`
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

migratePhase2();
