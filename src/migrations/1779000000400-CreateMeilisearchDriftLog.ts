import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Append-only audit log for MeiliSearch drift events detected by the
 * reconciliation cron.
 *
 * Background: ~68 direct SQL UPDATE statements across the codebase
 * (counted 2026-05-25) write to entities that should be in MeiliSearch
 * but bypass the Medusa event bus — so subscribers never fire and the
 * search index goes stale. The cron compares DB ↔ Meili every 5 minutes,
 * fixes drift, and writes a row here for every fix.
 *
 * Usage patterns:
 *   - `entity_type` + `entity_id`  → "this record drifted at time X"
 *   - `field_name`                 → which field was wrong
 *   - `source_hint`                → best-effort guess of the writer
 *     (e.g. last user that touched updated_at, last script name in the
 *     advisory_locks table, or "unknown"). Surfaces the culprit.
 *
 * NOT a row per check — only rows for actual drift.
 */
export class CreateMeilisearchDriftLog1779000000400
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS meilisearch_drift_log (
        id              TEXT PRIMARY KEY,
        entity_type     TEXT NOT NULL,
        entity_id       TEXT NOT NULL,
        field_name      TEXT NOT NULL,
        db_value        TEXT NULL,
        meili_value     TEXT NULL,
        source_hint     TEXT NULL,
        detected_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        fixed_at        TIMESTAMPTZ NULL,
        fix_error       TEXT NULL
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_msdl_entity
        ON meilisearch_drift_log(entity_type, entity_id, detected_at DESC)
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_msdl_detected_at
        ON meilisearch_drift_log(detected_at DESC)
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_msdl_unfixed
        ON meilisearch_drift_log(detected_at DESC)
        WHERE fixed_at IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_msdl_unfixed`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_msdl_detected_at`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_msdl_entity`);
    await queryRunner.query(`DROP TABLE IF EXISTS meilisearch_drift_log`);
  }
}
