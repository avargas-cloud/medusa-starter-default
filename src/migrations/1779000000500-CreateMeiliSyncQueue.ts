import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Postgres trigger-based MeiliSearch sync queue (Capa 2 of the 3-tier
 * MeiliSearch sync architecture).
 *
 * Why this matters:
 *   The Medusa subscriber-based sync (Capa 1) ONLY fires when the write
 *   goes through Modules.CUSTOMER / Modules.PRODUCT / etc. Roughly 68
 *   direct SQL UPDATE statements across this codebase bypass that and
 *   leave MeiliSearch stale. The 5-min reconciliation cron (Capa 3) is a
 *   safety net but a 100-orders/day shop can't afford up-to-5-min
 *   inconsistency multiple times per day.
 *
 *   This trigger fires on EVERY write to the watched tables, regardless
 *   of the writer (Medusa modules, raw SQL, psql shell, fix scripts,
 *   future code, anything). The row lands in `meili_sync_queue` and the
 *   `meili-sync-queue-processor` job picks it up within ~1 minute.
 *
 *   Combined latency: trigger ~instant + worker ~1 min = ≤1 min worst
 *   case for the most exotic write path.
 *
 * Phase 1 attaches the trigger only to `customer`. Extending to product,
 * product_variant, order, pos_invoice is one ALTER per table — adding
 * them is intentionally out of scope for the first ship so we can verify
 * the framework live before fanning out.
 */
export class CreateMeiliSyncQueue1779000000500 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Queue table — append-only log of pending syncs.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS meili_sync_queue (
        id              BIGSERIAL PRIMARY KEY,
        entity_type     TEXT NOT NULL,
        entity_id       TEXT NOT NULL,
        op              TEXT NOT NULL,
        queued_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
        processed_at    TIMESTAMPTZ NULL,
        attempt_count   INT NOT NULL DEFAULT 0,
        last_error      TEXT NULL,
        source_hint     TEXT NULL
      )
    `);

    // Pending-only index — worker query is "WHERE processed_at IS NULL".
    // Partial index keeps it small even as the table grows to millions.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_msq_pending
        ON meili_sync_queue(queued_at)
        WHERE processed_at IS NULL
    `);

    // Used by the dedup pass — find latest queued row per entity.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_msq_entity
        ON meili_sync_queue(entity_type, entity_id, queued_at DESC)
    `);

    // Generic trigger function — TG_ARGV[0] is the entity_type passed by
    // each per-table trigger. Uses NEW.id on INSERT/UPDATE, OLD.id on DELETE.
    //
    // application_name (set per-connection by Medusa / psql / scripts) is
    // captured as source_hint so the audit log can fingerprint who wrote.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION enqueue_meili_sync() RETURNS TRIGGER AS $$
      BEGIN
        INSERT INTO meili_sync_queue (entity_type, entity_id, op, source_hint)
        VALUES (
          TG_ARGV[0],
          COALESCE(NEW.id, OLD.id),
          TG_OP,
          current_setting('application_name', true)
        );
        RETURN COALESCE(NEW, OLD);
      END;
      $$ LANGUAGE plpgsql;
    `);

    // ── Per-table trigger: customer ─────────────────────────────────────
    // DROP first so re-runs are idempotent; CREATE OR REPLACE doesn't work
    // for triggers in PG.
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS trg_meili_sync_customer ON customer
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_meili_sync_customer
      AFTER INSERT OR UPDATE OR DELETE ON customer
      FOR EACH ROW EXECUTE FUNCTION enqueue_meili_sync('customer')
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TRIGGER IF EXISTS trg_meili_sync_customer ON customer`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS enqueue_meili_sync()`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_msq_entity`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_msq_pending`);
    await queryRunner.query(`DROP TABLE IF EXISTS meili_sync_queue`);
  }
}
