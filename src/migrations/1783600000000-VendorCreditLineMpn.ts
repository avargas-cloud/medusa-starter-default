import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * gl-purchases-v2 §3 follow-up — `vendor_credit_line` gains `mpn`, mirroring
 * `vendor_bill_line.mpn`. Plain expand-only column: this table is never
 * journaled directly (only the credit header posts to `bank_journal_entry`
 * via `postVendorCredit`), so none of `1783300000000`'s journal guards apply
 * here — just `ADD COLUMN IF NOT EXISTS` / `down()` drops it.
 */
export class VendorCreditLineMpn1783600000000 implements MigrationInterface {
  name = "VendorCreditLineMpn1783600000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE vendor_credit_line ADD COLUMN IF NOT EXISTS mpn text`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE vendor_credit_line DROP COLUMN IF EXISTS mpn`
    );
  }
}
