import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Serializes QuickBooks purchase mutations per PO through qb_order_pipeline.
 *
 * The legacy purchase tables remain the operator-facing document queues, while
 * qb_order_pipeline owns ordering and bridge dispatch for newly delegated
 * PurchaseOrderMod / ItemReceipt Add+Mod / Bill Add+Mod and reviewed Bill
 * rebuild operations.
 */
export class CreateQbPurchaseDependencyChain1781100000000 implements MigrationInterface {
  name = "CreateQbPurchaseDependencyChain1781100000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS qb_purchase_dependency_chain (
        purchase_order_id text PRIMARY KEY,
        tail_pipeline_id uuid NULL
          REFERENCES qb_order_pipeline(id) ON DELETE SET NULL,
        previous_tail_pipeline_id uuid NULL
          REFERENCES qb_order_pipeline(id) ON DELETE SET NULL,
        updated_at timestamptz NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query(`
      ALTER TABLE qb_order_pipeline
        ADD COLUMN IF NOT EXISTS purchase_operation_key text NULL
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_qb_order_pipeline_purchase_operation
        ON qb_order_pipeline(purchase_operation_key)
        WHERE purchase_operation_key IS NOT NULL
    `);

    await queryRunner.query(`
      ALTER TABLE qb_purchase_order_pipeline
        ADD COLUMN IF NOT EXISTS order_pipeline_id uuid NULL
          REFERENCES qb_order_pipeline(id) ON DELETE SET NULL
    `);
    await queryRunner.query(`
      ALTER TABLE qb_item_receipt_pipeline
        ADD COLUMN IF NOT EXISTS add_order_pipeline_id uuid NULL
          REFERENCES qb_order_pipeline(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS mod_order_pipeline_id uuid NULL
          REFERENCES qb_order_pipeline(id) ON DELETE SET NULL
    `);
    await queryRunner.query(`
      ALTER TABLE qb_vendor_bill_pipeline
        ADD COLUMN IF NOT EXISTS order_pipeline_id uuid NULL
          REFERENCES qb_order_pipeline(id) ON DELETE SET NULL
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_qb_purchase_order_pipeline_order_pipeline
        ON qb_purchase_order_pipeline(order_pipeline_id)
        WHERE order_pipeline_id IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_qb_item_receipt_pipeline_add_order_pipeline
        ON qb_item_receipt_pipeline(add_order_pipeline_id)
        WHERE add_order_pipeline_id IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_qb_item_receipt_pipeline_mod_order_pipeline
        ON qb_item_receipt_pipeline(mod_order_pipeline_id)
        WHERE mod_order_pipeline_id IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_qb_vendor_bill_pipeline_order_pipeline
        ON qb_vendor_bill_pipeline(order_pipeline_id)
        WHERE order_pipeline_id IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS uq_qb_order_pipeline_purchase_operation
    `);
    await queryRunner.query(`
      ALTER TABLE qb_order_pipeline
        DROP COLUMN IF EXISTS purchase_operation_key
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS idx_qb_vendor_bill_pipeline_order_pipeline
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS idx_qb_item_receipt_pipeline_mod_order_pipeline
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS idx_qb_item_receipt_pipeline_add_order_pipeline
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS idx_qb_purchase_order_pipeline_order_pipeline
    `);
    await queryRunner.query(`
      ALTER TABLE qb_vendor_bill_pipeline
        DROP COLUMN IF EXISTS order_pipeline_id
    `);
    await queryRunner.query(`
      ALTER TABLE qb_item_receipt_pipeline
        DROP COLUMN IF EXISTS mod_order_pipeline_id,
        DROP COLUMN IF EXISTS add_order_pipeline_id
    `);
    await queryRunner.query(`
      ALTER TABLE qb_purchase_order_pipeline
        DROP COLUMN IF EXISTS order_pipeline_id
    `);
    await queryRunner.query(`
      DROP TABLE IF EXISTS qb_purchase_dependency_chain
    `);
  }
}
