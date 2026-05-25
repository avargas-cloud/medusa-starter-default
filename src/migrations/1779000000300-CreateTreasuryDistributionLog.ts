import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Append-only audit log for treasury daily-split snapshots.
 *
 * - `snapshot_json` is the full GET /admin/accounting/treasury/daily payload
 *   captured at the moment the operator clicked "Snapshot". Frozen forever
 *   so historical reports stay reproducible even when COGS or origin tags
 *   later change.
 * - Multiple snapshots per `distribution_date` are legal (user may regenerate);
 *   only the row with `executed_at IS NOT NULL` is the authoritative
 *   "this is what I actually wired" record.
 * - `executed_at` is set exactly once via UPDATE ... WHERE executed_at IS NULL
 *   RETURNING * — concurrent clicks return 409.
 */
export class CreateTreasuryDistributionLog1779000000300
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS treasury_distribution_log (
        id                       TEXT PRIMARY KEY,
        distribution_date        DATE NOT NULL,
        generated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
        generated_by_user_id     TEXT NULL,
        snapshot_json            JSONB NOT NULL,
        executed_at              TIMESTAMPTZ NULL,
        executed_by_user_id      TEXT NULL,
        notes                    TEXT NULL,
        created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_tdl_distribution_date
        ON treasury_distribution_log(distribution_date DESC)
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_tdl_executed_at
        ON treasury_distribution_log(executed_at)
        WHERE executed_at IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_tdl_executed_at`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_tdl_distribution_date`);
    await queryRunner.query(`DROP TABLE IF EXISTS treasury_distribution_log`);
  }
}
