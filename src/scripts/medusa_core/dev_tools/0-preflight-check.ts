/**
 * Pre-Flight Check: Verify Database Foreign Keys
 *
 * Purpose:
 * - Verify all foreign keys have ON UPDATE CASCADE
 * - Check data integrity before migration
 * - Generate safety report
 *
 * Usage:
 *   npx tsx scripts/product-id-migration/0-preflight-check.ts
 */

import dotenv from "dotenv";
dotenv.config();

import knex from "knex";

const DB_URL = process.env.DATABASE_URL!;

async function main() {
  console.log("🔍 Product ID Migration - Pre-Flight Safety Check\n");

  const db = knex({
    client: "pg",
    connection: DB_URL,
  });

  try {
    // 1. Check foreign key constraints
    console.log("🔐 Checking Foreign Key Constraints...\n");

    const foreignKeys = await db.raw(`
            SELECT 
                tc.table_name,
                kcu.column_name,
                ccu.table_name AS foreign_table_name,
                ccu.column_name AS foreign_column_name,
                rc.update_rule,
                rc.delete_rule
            FROM information_schema.table_constraints AS tc
            JOIN information_schema.key_column_usage AS kcu
                ON tc.constraint_name = kcu.constraint_name
            JOIN information_schema.constraint_column_usage AS ccu
                ON ccu.constraint_name = tc.constraint_name
            JOIN information_schema.referential_constraints AS rc
                ON rc.constraint_name = tc.constraint_name
            WHERE tc.constraint_type = 'FOREIGN KEY'
                AND ccu.table_name = 'product'
                AND ccu.column_name = 'id'
            ORDER BY tc.table_name
        `);

    console.log("Tables with Foreign Keys to product.id:");
    console.log("─".repeat(80));

    let allHaveCascade = true;
    foreignKeys.rows.forEach((fk: any) => {
      const hasCascade = fk.update_rule === "CASCADE";
      const symbol = hasCascade ? "✅" : "❌";
      console.log(`${symbol} ${fk.table_name}.${fk.column_name}`);
      console.log(`   Update Rule: ${fk.update_rule}`);
      console.log(`   Delete Rule: ${fk.delete_rule}`);
      console.log();

      if (!hasCascade) {
        allHaveCascade = false;
      }
    });

    if (!allHaveCascade) {
      console.log("⚠️  WARNING: Some foreign keys do NOT have CASCADE!");
      console.log("   Migration may fail or leave orphaned records.");
      console.log("   Consider adding CASCADE constraints first.\n");
    } else {
      console.log("✅ All foreign keys have ON UPDATE CASCADE\n");
    }

    // 2. Count critical relationships
    console.log("📊 Data Integrity Check:\n");

    const productCount = await db("product").count("* as count").first();
    console.log(`Products: ${productCount?.count}`);

    const variantCount = await db("product_variant")
      .count("* as count")
      .first();
    console.log(`Variants: ${variantCount?.count}`);

    const imageCount = await db("image").count("* as count").first();
    console.log(`Images: ${imageCount?.count}`);

    const priceCount = await db("price").count("* as count").first();
    console.log(`Prices: ${priceCount?.count}`);

    const categoryLinkCount = await db("product_category_product")
      .count("* as count")
      .first();
    console.log(`Category Links: ${categoryLinkCount?.count}`);

    // 3. Check for orphaned records (shouldn't exist but verify)
    console.log("\n🔍 Checking for Existing Orphans:\n");

    const orphanedVariants = await db.raw(`
            SELECT COUNT(*) as count
            FROM product_variant pv
            LEFT JOIN product p ON pv.product_id = p.id
            WHERE p.id IS NULL
        `);
    console.log(
      `Orphaned Variants: ${orphanedVariants.rows[0].count} ${orphanedVariants.rows[0].count > 0 ? "⚠️" : "✅"}`
    );

    const orphanedImages = await db.raw(`
            SELECT COUNT(*) as count
            FROM image pi
            LEFT JOIN product p ON pi.product_id = p.id
            WHERE p.id IS NULL
        `);
    console.log(
      `Orphaned Images: ${orphanedImages.rows[0].count} ${orphanedImages.rows[0].count > 0 ? "⚠️" : "✅"}`
    );

    const orphanedCategories = await db.raw(`
            SELECT COUNT(*) as count
            FROM product_category_product pcp
            LEFT JOIN product p ON pcp.product_id = p.id
            WHERE p.id IS NULL
        `);
    console.log(
      `Orphaned Category Links: ${orphanedCategories.rows[0].count} ${orphanedCategories.rows[0].count > 0 ? "⚠️" : "✅"}`
    );

    // 4. Summary
    console.log("\n─".repeat(80));
    console.log("✅ PRE-FLIGHT CHECK COMPLETE\n");

    if (
      allHaveCascade &&
      orphanedVariants.rows[0].count === 0 &&
      orphanedImages.rows[0].count === 0 &&
      orphanedCategories.rows[0].count === 0
    ) {
      console.log("🟢 SAFE TO PROCEED with migration");
      console.log("\nNext steps:");
      console.log("  1. Create full database backup");
      console.log(
        "  2. Run Phase 1: npx tsx scripts/product-id-migration/1-generate-mappings.ts"
      );
      console.log(
        "  3. Run Phase 2: npx tsx scripts/product-id-migration/2-update-metadata.ts"
      );
      console.log(
        "  4. Run Phase 3: npx tsx scripts/product-id-migration/3-migrate-database.ts"
      );
    } else {
      console.log("🟡 WARNINGS DETECTED");
      console.log("   Review warnings above before proceeding");
    }
    console.log();
  } catch (error) {
    console.error("❌ Pre-flight check failed:", error);
    throw error;
  } finally {
    await db.destroy();
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
