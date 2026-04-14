import { Migration } from "@mikro-orm/migrations";

export class Migration17072424000000 extends Migration {
  async up(): Promise<void> {
    // Product-Category relationship lookups (speeds up category → products queries)
    this.addSql(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_product_category_product_category_lookup 
      ON product_category_product(product_category_id);
    `);

    this.addSql(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_product_category_product_product_lookup 
      ON product_category_product(product_id);
    `);

    // Category tree traversal (speeds up descendant category queries)
    this.addSql(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_product_category_parent_lookup 
      ON product_category(parent_category_id) 
      WHERE parent_category_id IS NOT NULL;
    `);

    // Product variant pricing (speeds up price calculations)
    this.addSql(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_product_variant_product_lookup 
      ON product_variant(product_id);
    `);

    // Inventory level lookups (speeds up stock queries)
    this.addSql(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_inventory_level_inventory_lookup 
      ON inventory_level(inventory_item_id);
    `);

    console.log("✅ Performance indexes created successfully");
  }

  async down(): Promise<void> {
    // Drop indexes in reverse order
    this.addSql(
      `DROP INDEX CONCURRENTLY IF EXISTS idx_inventory_level_inventory_lookup;`
    );
    this.addSql(
      `DROP INDEX CONCURRENTLY IF EXISTS idx_product_variant_product_lookup;`
    );
    this.addSql(
      `DROP INDEX CONCURRENTLY IF EXISTS idx_product_category_parent_lookup;`
    );
    this.addSql(
      `DROP INDEX CONCURRENTLY IF EXISTS idx_product_category_product_product_lookup;`
    );
    this.addSql(
      `DROP INDEX CONCURRENTLY IF EXISTS idx_product_category_product_category_lookup;`
    );

    console.log("✅ Performance indexes dropped successfully");
  }
}
