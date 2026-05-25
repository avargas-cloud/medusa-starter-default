import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Treasury Bucket registry — maps a logical accounting bucket (china_cogs,
 * local_cogs, tax_holding, operating, reserve) to a pair of qb_bank_account
 * rows: the source (where the wire originates from) and the destination
 * (where the wire goes).
 *
 * Both FKs are nullable until the operator maps them in /settings.
 * `code` is the stable identifier used by the daily-split endpoint; labels
 * and ordering are user-editable; `qb_bank_account_id` (destination) is
 * required for the bucket to appear with a real bank in the report.
 */
export class CreateTreasuryBucket1779000000200 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS treasury_bucket (
        id                          TEXT PRIMARY KEY,
        code                        TEXT NOT NULL UNIQUE,
        label                       TEXT NOT NULL,
        source_qb_bank_account_id   TEXT NULL REFERENCES qb_bank_account(id) ON DELETE SET NULL,
        qb_bank_account_id          TEXT NULL REFERENCES qb_bank_account(id) ON DELETE SET NULL,
        display_order               INT  NOT NULL DEFAULT 0,
        is_active                   BOOLEAN NOT NULL DEFAULT TRUE,
        created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT treasury_bucket_code_chk
          CHECK (code IN ('china_cogs','local_cogs','tax_holding','operating','reserve'))
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_treasury_bucket_display_order
        ON treasury_bucket(display_order)
    `);

    // Seed the 5 buckets; bank mappings remain NULL until the operator
    // wires them via the settings page.
    await queryRunner.query(`
      INSERT INTO treasury_bucket (id, code, label, display_order, is_active)
      VALUES
        ('tbk_china_cogs',  'china_cogs',  'China COGS',  10, TRUE),
        ('tbk_local_cogs',  'local_cogs',  'Local COGS',  20, TRUE),
        ('tbk_tax_holding', 'tax_holding', 'Tax Holding', 30, TRUE),
        ('tbk_operating',   'operating',   'Operating',   40, TRUE),
        ('tbk_reserve',     'reserve',     'Reserve',     50, FALSE)
      ON CONFLICT (code) DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_treasury_bucket_display_order`);
    await queryRunner.query(`DROP TABLE IF EXISTS treasury_bucket`);
  }
}
