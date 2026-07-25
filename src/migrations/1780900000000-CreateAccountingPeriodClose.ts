import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateAccountingPeriodClose1780900000000
  implements MigrationInterface
{
  name = "CreateAccountingPeriodClose1780900000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS accounting_period_close (
        id                  text PRIMARY KEY,
        period_start        date        NOT NULL,
        period_end          date        NOT NULL,
        revision            integer     NOT NULL,
        status              text        NOT NULL DEFAULT 'closed',
        summary             jsonb       NOT NULL,
        open_documents      jsonb       NOT NULL,
        readiness           jsonb       NOT NULL,
        inventory_snapshots jsonb       NOT NULL DEFAULT '[]'::jsonb,
        close_note          text        NULL,
        closed_by_user_id   text        NOT NULL,
        closed_at           timestamptz NOT NULL DEFAULT NOW(),
        reopened_by_user_id text        NULL,
        reopened_at         timestamptz NULL,
        reopen_reason       text        NULL,
        reopen_preview      jsonb       NULL,
        created_at          timestamptz NOT NULL DEFAULT NOW(),
        updated_at          timestamptz NOT NULL DEFAULT NOW(),
        CONSTRAINT accounting_period_close_dates
          CHECK (period_end > period_start),
        CONSTRAINT accounting_period_close_status
          CHECK (status IN ('closed', 'reopened'))
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_accounting_period_close_revision
        ON accounting_period_close (period_start, revision)
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_accounting_period_active_close
        ON accounting_period_close (period_start)
        WHERE status = 'closed'
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_accounting_period_close_range
        ON accounting_period_close (period_start, period_end)
        WHERE status = 'closed'
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS accounting_period_adjustment (
        id                    text PRIMARY KEY,
        source_close_id       text        NOT NULL
          REFERENCES accounting_period_close(id),
        target_period_start   date        NOT NULL,
        target_period_end     date        NOT NULL,
        status                text        NOT NULL DEFAULT 'posted',
        delta                 jsonb       NOT NULL,
        source_input_hash     text        NOT NULL,
        reason                text        NOT NULL,
        posted_by_user_id     text        NOT NULL,
        posted_at             timestamptz NOT NULL DEFAULT NOW(),
        qb_status             text        NOT NULL DEFAULT 'not_posted',
        qb_reference          text        NULL,
        reversed_by_user_id   text        NULL,
        reversed_at           timestamptz NULL,
        reversal_reason       text        NULL,
        created_at            timestamptz NOT NULL DEFAULT NOW(),
        updated_at            timestamptz NOT NULL DEFAULT NOW(),
        CONSTRAINT accounting_period_adjustment_status
          CHECK (status IN ('posted', 'reversed'))
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_accounting_period_adjustment_source
        ON accounting_period_adjustment (source_close_id)
        WHERE status = 'posted'
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_accounting_period_adjustment_target
        ON accounting_period_adjustment (target_period_start)
        WHERE status = 'posted'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS accounting_period_adjustment`);
    await queryRunner.query(`DROP TABLE IF EXISTS accounting_period_close`);
  }
}
