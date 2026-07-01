import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * China Finance — Split Bills into "Partial #N" records (F1).
 *
 * Adds the split-group columns + guards to `china_finance_bill`. The physical
 * child rows are produced by the separate, verifiable backfill script
 * (`scripts/migrations/backfill-china-finance-split-bills.ts`), NOT here — this
 * migration only prepares the schema so the backfill (and the runtime delta
 * engine) have somewhere to write.
 *
 * The UNIQUE(bill_id) backstop on china_wire_transfer_application is deliberately
 * NOT created here: current prod data legitimately has one bill spanning multiple
 * wire applications, so the index can only be added AFTER the backfill splits
 * those into one-application-per-child. It is created at the tail of the backfill
 * script once the data is clean.
 */
export class AddChinaFinanceBillSplitColumns1779700000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── Columns ──────────────────────────────────────────────────────────────
    // split_group_id: id of the root bill that anchors a split group (self-ref).
    //                 NULL = plain, un-split bill.
    // partial_seq:    1..k position within the group. NULL when un-split.
    // split_version:  optimistic-lock counter bumped on every group mutation, so
    //                 the draft modal can detect a mid-edit split (409).
    await queryRunner.query(`
      ALTER TABLE china_finance_bill
        ADD COLUMN IF NOT EXISTS split_group_id TEXT NULL
          REFERENCES china_finance_bill(id),
        ADD COLUMN IF NOT EXISTS partial_seq    INTEGER NULL,
        ADD COLUMN IF NOT EXISTS split_version  INTEGER NOT NULL DEFAULT 0
    `);

    // ── Guards ───────────────────────────────────────────────────────────────
    // amount_cents may legitimately reach 0 (a fully-absorbed audit sibling) but
    // never negative. Named so `down()` / re-runs are idempotent.
    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'chk_cfb_amount_nonneg'
        ) THEN
          ALTER TABLE china_finance_bill
            ADD CONSTRAINT chk_cfb_amount_nonneg CHECK (amount_cents >= 0);
        END IF;
      END $$
    `);

    // split_group_id and partial_seq are set together; partial_seq >= 1.
    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'chk_cfb_split_consistency'
        ) THEN
          ALTER TABLE china_finance_bill
            ADD CONSTRAINT chk_cfb_split_consistency CHECK (
              (split_group_id IS NULL AND partial_seq IS NULL) OR
              (split_group_id IS NOT NULL AND partial_seq IS NOT NULL AND partial_seq >= 1)
            );
        END IF;
      END $$
    `);

    // ── Indexes ──────────────────────────────────────────────────────────────
    // One row per (group, seq); fast lookup of a whole split group in order.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_cfb_split_seq
        ON china_finance_bill(split_group_id, partial_seq)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_cfb_split_group
        ON china_finance_bill(split_group_id, partial_seq)
    `);

    // Each vendor bill maps to exactly ONE finance-bill root (only roots keep
    // vendor_bill_id). A duplicate would make the group-aware sync process the
    // same vendor total against two groups → double-counted expenses.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_cfb_vendor_bill_once
        ON china_finance_bill(vendor_bill_id) WHERE vendor_bill_id IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_cfb_vendor_bill_once`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_cfb_split_group`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_cfb_split_seq`);
    await queryRunner.query(`
      ALTER TABLE china_finance_bill
        DROP CONSTRAINT IF EXISTS chk_cfb_split_consistency,
        DROP CONSTRAINT IF EXISTS chk_cfb_amount_nonneg,
        DROP COLUMN IF EXISTS split_version,
        DROP COLUMN IF EXISTS partial_seq,
        DROP COLUMN IF EXISTS split_group_id
    `);
  }
}
