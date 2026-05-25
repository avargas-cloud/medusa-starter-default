import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Extend the Capa-2 meili sync trigger setup to `product` and
 * `product_variant`.
 *
 *  - product trigger:          enqueues entity_id = NEW.id        (entity_type='product')
 *  - product_variant trigger:  enqueues entity_id = NEW.product_id (entity_type='product')
 *
 * The variant case uses a dedicated trigger function because the
 * generic `enqueue_meili_sync` always passes COALESCE(NEW.id, OLD.id),
 * but for variants we want to sync the PARENT product (since `variant_sku`
 * is a field on the parent's Meili doc, not its own doc).
 */
export class AddProductMeiliSyncTriggers1779000000600 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── Trigger function: enqueue PARENT product when a variant changes ─
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION enqueue_meili_sync_from_variant() RETURNS TRIGGER AS $$
      DECLARE
        target_product_id TEXT;
      BEGIN
        target_product_id := COALESCE(NEW.product_id, OLD.product_id);
        IF target_product_id IS NULL THEN
          RETURN COALESCE(NEW, OLD);
        END IF;
        INSERT INTO meili_sync_queue (entity_type, entity_id, op, source_hint)
        VALUES (
          'product',
          target_product_id,
          TG_OP,
          current_setting('application_name', true)
        );
        RETURN COALESCE(NEW, OLD);
      END;
      $$ LANGUAGE plpgsql;
    `);

    // ── Per-table triggers ──────────────────────────────────────────────
    await queryRunner.query(`DROP TRIGGER IF EXISTS trg_meili_sync_product ON product`);
    await queryRunner.query(`
      CREATE TRIGGER trg_meili_sync_product
      AFTER INSERT OR UPDATE OR DELETE ON product
      FOR EACH ROW EXECUTE FUNCTION enqueue_meili_sync('product')
    `);

    await queryRunner.query(`DROP TRIGGER IF EXISTS trg_meili_sync_product_variant ON product_variant`);
    await queryRunner.query(`
      CREATE TRIGGER trg_meili_sync_product_variant
      AFTER INSERT OR UPDATE OR DELETE ON product_variant
      FOR EACH ROW EXECUTE FUNCTION enqueue_meili_sync_from_variant()
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TRIGGER IF EXISTS trg_meili_sync_product_variant ON product_variant`);
    await queryRunner.query(`DROP TRIGGER IF EXISTS trg_meili_sync_product ON product`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS enqueue_meili_sync_from_variant()`);
  }
}
