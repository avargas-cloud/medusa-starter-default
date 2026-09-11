import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Plan `vc-edit-mod-20260911` — a posted vendor credit can be revised and the
 * revision travels to QuickBooks as a `VendorCreditMod`. A Mod addresses each
 * existing line by its QuickBooks `TxnLineID` (omitted lines are deleted,
 * `-1` adds one), so the line id the `VendorCreditRet` returns on Add/Mod
 * confirmation is persisted here — same role as `vendor_bill_line.qb_txn_line_id`.
 * Expand-only, nullable, no backfill (lines confirmed before this column
 * simply carry NULL and are re-sent as new on the first Mod).
 */
export class VendorCreditLineQbTxnLineId1783800000000 implements MigrationInterface {
  name = "VendorCreditLineQbTxnLineId1783800000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE vendor_credit_line ADD COLUMN IF NOT EXISTS qb_txn_line_id text NULL`
    );
    await queryRunner.query(
      `ALTER TABLE vendor_credit ADD COLUMN IF NOT EXISTS revised_at timestamptz NULL`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE vendor_credit DROP COLUMN IF EXISTS revised_at`);
    await queryRunner.query(
      `ALTER TABLE vendor_credit_line DROP COLUMN IF EXISTS qb_txn_line_id`
    );
  }
}
