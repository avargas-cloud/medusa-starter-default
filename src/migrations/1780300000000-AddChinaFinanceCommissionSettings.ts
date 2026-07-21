import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * China Finance — settings backing the vendor-bill DRIFT check.
 *
 * The purchasing agent (Veetech) issues its OWN service invoice for the
 * commission; we do NOT compute it. These two settings only power a
 * RECONCILIATION signal: from the commission the agent billed we derive the
 * goods base they used (`commission / rate`) and compare it against what our
 * regular bill declares. A mismatch means one of the two documents is stale —
 * historically it has always been ours.
 *
 * `commission_tolerance_cents` absorbs the agent's own rounding (measured
 * across 18 historical bill pairs the deviation never exceeded 0.5¢), so only a
 * material difference — a quantity change — raises the flag. Default 10¢ per
 * the buyer: the agent's cent-level rounding must never raise an alarm.
 */
export class AddChinaFinanceCommissionSettings1780300000000
  implements MigrationInterface
{
  name = "AddChinaFinanceCommissionSettings1780300000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE china_finance_settings
        ADD COLUMN IF NOT EXISTS agent_commission_rate_bps integer NOT NULL DEFAULT 1500,
        ADD COLUMN IF NOT EXISTS commission_tolerance_cents integer NOT NULL DEFAULT 10
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE china_finance_settings
        DROP COLUMN IF EXISTS agent_commission_rate_bps,
        DROP COLUMN IF EXISTS commission_tolerance_cents
    `);
  }
}
