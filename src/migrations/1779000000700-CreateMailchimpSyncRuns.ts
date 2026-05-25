import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Append-only log of every Mailchimp sync pass (cron + manual backfill).
 *
 * Powers the /email-marketing dashboard's "Last cron run" card and the
 * daily-activity chart. One row per pass; the most recent row WHERE
 * triggered_by='cron' AND ended_at IS NOT NULL is the canonical "last
 * automated sync" status.
 */
export class CreateMailchimpSyncRuns1779000000700 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS mailchimp_sync_runs (
        id                    TEXT PRIMARY KEY,
        triggered_by          TEXT NOT NULL,
        started_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
        ended_at              TIMESTAMPTZ NULL,
        scope                 TEXT NULL,
        cutoff_used            TIMESTAMPTZ NULL,
        processed             INT NOT NULL DEFAULT 0,
        created               INT NOT NULL DEFAULT 0,
        updated               INT NOT NULL DEFAULT 0,
        skipped_compliance    INT NOT NULL DEFAULT 0,
        errors                INT NOT NULL DEFAULT 0,
        error_sample          JSONB NULL,
        notes                 TEXT NULL
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_msr_started_at
        ON mailchimp_sync_runs(started_at DESC)
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_msr_cron_ended
        ON mailchimp_sync_runs(started_at DESC)
        WHERE triggered_by = 'cron' AND ended_at IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_msr_cron_ended`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_msr_started_at`);
    await queryRunner.query(`DROP TABLE IF EXISTS mailchimp_sync_runs`);
  }
}
