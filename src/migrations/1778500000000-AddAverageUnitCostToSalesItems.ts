import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Adds an immutable cost snapshot pair to invoice and credit-memo line items
 * so margin / profit reports can be computed without re-fetching the variant
 * (whose cost may drift after the sale).
 *
 * Source of truth at snapshot time:
 *   - product_variant.metadata->>'qb_avg_cost'           (string decimal)
 *   - product_variant.metadata->>'qb_avg_cost_synced_at' (ISO timestamp,
 *     written by sync-average-cost-core.ts on every successful QB sync)
 *
 * Behavior:
 *   - Both columns are NULLable. ~3.7% of active variants have no qb_avg_cost
 *     (never synced from QB), and custom / non-variant lines have no variant
 *     to look up — these legitimately store NULL.
 *   - Once written, values are FROZEN. QB sync never back-propagates to
 *     existing invoice / credit-memo items. The whole point of the snapshot.
 *   - `average_unit_cost` is declared with `model.bigNumber().nullable()` in
 *     the ORM, which materializes as both `<field>` (numeric) and
 *     `raw_<field>` (jsonb) — the standard Medusa v2 monetary pattern.
 */
export class AddAverageUnitCostToSalesItems1778500000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // pos_invoice_item
    await queryRunner.query(
      `ALTER TABLE pos_invoice_item ADD COLUMN IF NOT EXISTS average_unit_cost NUMERIC NULL`
    );
    await queryRunner.query(
      `ALTER TABLE pos_invoice_item ADD COLUMN IF NOT EXISTS raw_average_unit_cost JSONB NULL`
    );
    await queryRunner.query(
      `ALTER TABLE pos_invoice_item ADD COLUMN IF NOT EXISTS average_unit_cost_synced_at TIMESTAMPTZ NULL`
    );

    // pos_credit_memo_item
    await queryRunner.query(
      `ALTER TABLE pos_credit_memo_item ADD COLUMN IF NOT EXISTS average_unit_cost NUMERIC NULL`
    );
    await queryRunner.query(
      `ALTER TABLE pos_credit_memo_item ADD COLUMN IF NOT EXISTS raw_average_unit_cost JSONB NULL`
    );
    await queryRunner.query(
      `ALTER TABLE pos_credit_memo_item ADD COLUMN IF NOT EXISTS average_unit_cost_synced_at TIMESTAMPTZ NULL`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE pos_credit_memo_item DROP COLUMN IF EXISTS average_unit_cost_synced_at`
    );
    await queryRunner.query(
      `ALTER TABLE pos_credit_memo_item DROP COLUMN IF EXISTS raw_average_unit_cost`
    );
    await queryRunner.query(
      `ALTER TABLE pos_credit_memo_item DROP COLUMN IF EXISTS average_unit_cost`
    );
    await queryRunner.query(
      `ALTER TABLE pos_invoice_item DROP COLUMN IF EXISTS average_unit_cost_synced_at`
    );
    await queryRunner.query(
      `ALTER TABLE pos_invoice_item DROP COLUMN IF EXISTS raw_average_unit_cost`
    );
    await queryRunner.query(
      `ALTER TABLE pos_invoice_item DROP COLUMN IF EXISTS average_unit_cost`
    );
  }
}
