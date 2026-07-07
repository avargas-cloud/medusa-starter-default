import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Migration20260707000000
 *
 * Seeds the per-ABC-class factory (manufacturing) days multipliers into
 * purchasing_config. These were previously hardcoded (A=1.0, B=0.7, C=0.5) in
 * both the backend snapshot service and the store-pos FactoryCell tooltip.
 * They are now configurable from the purchasing-analysis settings modal
 * (PUT /admin/purchasing/config).
 *
 *   effectiveDays = round(production_days * factory_mult_<class>)
 */
export class Migration20260707000000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      insert into "purchasing_config" ("key", "value", "label") values
        ('factory_mult_a', '1.00', 'Factory days multiplier: Class A (100%)'),
        ('factory_mult_b', '0.70', 'Factory days multiplier: Class B (70%)'),
        ('factory_mult_c', '0.50', 'Factory days multiplier: Class C (50%)')
      on conflict ("key") do nothing;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      delete from "purchasing_config"
      where "key" in ('factory_mult_a', 'factory_mult_b', 'factory_mult_c');
    `);
  }
}
