import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Vendor credit ↔ purchase order link (plan `vc-po-return-20260911`).
 *
 * A vendor credit that returns goods names the PO the goods came from
 * (`purchase_order_id`), the regular vendor bill that invoiced them
 * (`vendor_bill_id`, resolved from the PO — editable while draft), and each
 * product line points at the PO line it returns (`purchase_order_line_id`)
 * so the "returned ≤ received" cap can be enforced per PO line across every
 * active credit.
 *
 * `stock_applied_at` / `stock_reversed_at` are the idempotency marks of the
 * stock movement: posting a credit with returned items decrements
 * `inventory_level` at the PO's location (via the Inventory module, never
 * SQL), voiding it puts the units back. Same one-shot discipline as
 * `purchase_order_receipt_line.stock_applied`.
 *
 * Expand-only: nullable columns, no FK (same snapshotted-reference pattern
 * as `vendor_bill.purchase_order_id`), no backfill — a credit created before
 * this migration simply has no PO.
 */
export class VendorCreditPoLink1783700000000 implements MigrationInterface {
  name = "VendorCreditPoLink1783700000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE vendor_credit ADD COLUMN IF NOT EXISTS purchase_order_id text NULL`
    );
    await queryRunner.query(
      `ALTER TABLE vendor_credit ADD COLUMN IF NOT EXISTS vendor_bill_id text NULL`
    );
    await queryRunner.query(
      `ALTER TABLE vendor_credit ADD COLUMN IF NOT EXISTS stock_applied_at timestamptz NULL`
    );
    await queryRunner.query(
      `ALTER TABLE vendor_credit ADD COLUMN IF NOT EXISTS stock_reversed_at timestamptz NULL`
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_vendor_credit_po ON vendor_credit (purchase_order_id)
        WHERE purchase_order_id IS NOT NULL AND deleted_at IS NULL`
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_vendor_credit_bill ON vendor_credit (vendor_bill_id)
        WHERE vendor_bill_id IS NOT NULL AND deleted_at IS NULL`
    );

    await queryRunner.query(
      `ALTER TABLE vendor_credit_line ADD COLUMN IF NOT EXISTS purchase_order_line_id text NULL`
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_vendor_credit_line_po_line ON vendor_credit_line (purchase_order_line_id)
        WHERE purchase_order_line_id IS NOT NULL AND deleted_at IS NULL`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_vendor_credit_line_po_line`);
    await queryRunner.query(
      `ALTER TABLE vendor_credit_line DROP COLUMN IF EXISTS purchase_order_line_id`
    );
    await queryRunner.query(`DROP INDEX IF EXISTS idx_vendor_credit_bill`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_vendor_credit_po`);
    await queryRunner.query(`ALTER TABLE vendor_credit DROP COLUMN IF EXISTS stock_reversed_at`);
    await queryRunner.query(`ALTER TABLE vendor_credit DROP COLUMN IF EXISTS stock_applied_at`);
    await queryRunner.query(`ALTER TABLE vendor_credit DROP COLUMN IF EXISTS vendor_bill_id`);
    await queryRunner.query(`ALTER TABLE vendor_credit DROP COLUMN IF EXISTS purchase_order_id`);
  }
}
