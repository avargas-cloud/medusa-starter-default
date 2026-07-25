import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateVendorBillRevision1781000000000 implements MigrationInterface {
  name = "CreateVendorBillRevision1781000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS vendor_bill_revision (
        id                    text PRIMARY KEY,
        vendor_bill_id        text NOT NULL,
        revision_number       integer NOT NULL,
        status                text NOT NULL,
        input_hash            text NULL,
        header_snapshot       jsonb NOT NULL,
        lines_snapshot        jsonb NOT NULL,
        cost_plan_snapshot    jsonb NULL,
        confirmed_by_user_id  text NULL,
        confirmed_at          timestamptz NULL,
        superseded_at         timestamptz NULL,
        created_at            timestamptz NOT NULL DEFAULT NOW(),
        updated_at            timestamptz NOT NULL DEFAULT NOW(),
        CONSTRAINT chk_vendor_bill_revision_status
          CHECK (status IN ('draft','confirmed','superseded','aborted')),
        CONSTRAINT uq_vendor_bill_revision_number
          UNIQUE (vendor_bill_id, revision_number)
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_vendor_bill_revision_confirmed
        ON vendor_bill_revision (vendor_bill_id)
        WHERE status = 'confirmed'
    `);
    await queryRunner.query(`
      ALTER TABLE vendor_bill
        ADD COLUMN IF NOT EXISTS active_revision_id text NULL,
        ADD COLUMN IF NOT EXISTS draft_revision_number integer NULL
    `);
    await queryRunner.query(`
      ALTER TABLE vendor_bill
        DROP CONSTRAINT IF EXISTS vendor_bill_status_check
    `);
    await queryRunner.query(`
      ALTER TABLE vendor_bill
        ADD CONSTRAINT vendor_bill_status_check
        CHECK (status IN ('draft','confirmed','synced','cancelled','voided'))
    `);
    await queryRunner.query(`
      ALTER TABLE vendor_bill_cost_log
        ADD COLUMN IF NOT EXISTS vendor_bill_revision_id text NULL,
        ADD COLUMN IF NOT EXISTS receipt_id text NULL
    `);
    // D6 bills can cover several receipts for the same variant. Legacy logs
    // were inserted in receipt chronology but did not retain the receipt id.
    // Pair the two ordered sets once so historical replay preserves the actual
    // economic date rather than assigning every log to the bill's first receipt.
    await queryRunner.query(`
      WITH ranked_logs AS (
        SELECT l.id, l.vendor_bill_id, l.product_variant_id,
               ROW_NUMBER() OVER (
                 PARTITION BY l.vendor_bill_id, l.product_variant_id
                 ORDER BY l.applied_at, l.id
               ) AS rn
          FROM vendor_bill_cost_log l
         WHERE l.receipt_id IS NULL
      ),
      ranked_receipts AS (
        SELECT r.vendor_bill_id,
               rl.product_variant_id,
               r.id AS receipt_id,
               ROW_NUMBER() OVER (
                 PARTITION BY r.vendor_bill_id, rl.product_variant_id
                 ORDER BY r.received_at, r.seq, rl.id
               ) AS rn
          FROM purchase_order_receipt r
          JOIN purchase_order_receipt_line rl
            ON rl.purchase_order_receipt_id = r.id
           AND rl.deleted_at IS NULL
         WHERE r.vendor_bill_id IS NOT NULL
           AND r.deleted_at IS NULL
           AND r.voided_at IS NULL
           AND rl.qty_received_now > 0
      )
      UPDATE vendor_bill_cost_log l
         SET receipt_id = rr.receipt_id,
             updated_at = NOW()
        FROM ranked_logs logs
        JOIN ranked_receipts rr
          ON rr.vendor_bill_id = logs.vendor_bill_id
         AND rr.product_variant_id = logs.product_variant_id
         AND rr.rn = logs.rn
       WHERE l.id = logs.id
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_vendor_bill_cost_log_revision
        ON vendor_bill_cost_log (vendor_bill_revision_id)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_vendor_bill_cost_log_receipt
        ON vendor_bill_cost_log (receipt_id)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE vendor_bill_cost_log
         DROP COLUMN IF EXISTS receipt_id,
         DROP COLUMN IF EXISTS vendor_bill_revision_id`
    );
    await queryRunner.query(`
      ALTER TABLE vendor_bill
        DROP COLUMN IF EXISTS active_revision_id,
        DROP COLUMN IF EXISTS draft_revision_number
    `);
    await queryRunner.query(`DROP TABLE IF EXISTS vendor_bill_revision`);
  }
}
