import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * `inventory_valuation_snapshot` (+ _line) — immutable point-in-time records of
 * what a warehouse was worth (Phase 2 of the cost-basis work).
 *
 * WHY (2026-07-24): the Supply Chain report reconstructs a period's opening and
 * closing inventory value by replaying movements backward from today's live
 * stock. Phase 1 made that walk reconcile to $0.00, but it has no MEMORY — the
 * moment costs change again (a QB sync, a vendor-bill confirm), every past
 * month's Initial/Final silently moves with them. That is fine as a live,
 * always-current view, but it is not an accounting control: a closed month
 * should not change after it is closed.
 *
 * These tables give a frozen boundary. A snapshot captures, per variant, the
 * quantity on hand and the unit cost it was carried at, so:
 *   - a CUTOVER ANCHOR taken now records "this is our trustworthy starting
 *     point" (Codex's recommendation: anchor right after a clean cost sync);
 *   - MONTH_CLOSE snapshots accumulate going forward, each frozen at the value
 *     that was true when the month closed;
 *   - Phase 3 can then name a cost revaluation as the difference between two
 *     frozen bases instead of valuing history at today's cost.
 *
 * Immutability is by contract: nothing UPDATEs or DELETEs a completed snapshot.
 * A correction supersedes — a new snapshot is inserted and the old one's
 * `status` moves to 'superseded' with `superseded_by_snapshot_id` set. The
 * numbers a colleague saw at close time stay recoverable forever.
 *
 * This migration does NOT change what the report displays. Capturing the record
 * is pure upside; whether the report should READ frozen values (and stop the
 * living numbers from moving) is a separate, deliberate decision.
 */
export class CreateInventoryValuationSnapshot1780800000000
  implements MigrationInterface
{
  name = "CreateInventoryValuationSnapshot1780800000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS inventory_valuation_snapshot (
        id                        text PRIMARY KEY,
        stock_location_id         text        NOT NULL,
        -- The instant the value represents (a month close is the last moment
        -- of the month), NOT necessarily when the row was written.
        as_of_at                  timestamptz NOT NULL,
        -- cutover_anchor | month_close | manual | nightly
        snapshot_type             text        NOT NULL,
        -- Which cost each line is valued at, so two snapshots are only compared
        -- on the same basis: landed_avg (Miami) | factory (China).
        cost_basis                text        NOT NULL,
        -- building -> complete; a correction moves an old one to superseded.
        status                    text        NOT NULL DEFAULT 'complete',
        superseded_by_snapshot_id text        NULL,
        variant_count             integer     NOT NULL DEFAULT 0,
        total_quantity            bigint      NOT NULL DEFAULT 0,
        total_value_cents         bigint      NOT NULL DEFAULT 0,
        captured_by_user_id       text        NULL,
        source_note               text        NULL,
        created_at                timestamptz NOT NULL DEFAULT NOW()
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS inventory_valuation_snapshot_line (
        id                 text PRIMARY KEY,
        snapshot_id        text          NOT NULL
          REFERENCES inventory_valuation_snapshot(id) ON DELETE CASCADE,
        product_variant_id text          NOT NULL,
        quantity           integer       NOT NULL,
        -- numeric(19,4), not float — the whole point is a durable exact record.
        unit_cost          numeric(19,4) NOT NULL,
        value_cents        bigint        NOT NULL,
        created_at         timestamptz   NOT NULL DEFAULT NOW()
      )
    `);

    // "Latest complete snapshot for this location on or before date D" — the
    // report's future read path, and how a month-close finds the prior anchor.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_inv_val_snapshot_loc_asof
         ON inventory_valuation_snapshot (stock_location_id, as_of_at DESC)
       WHERE status = 'complete'`
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_inv_val_snapshot_line_snapshot
         ON inventory_valuation_snapshot_line (snapshot_id)`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS inventory_valuation_snapshot_line`
    );
    await queryRunner.query(`DROP TABLE IF EXISTS inventory_valuation_snapshot`);
  }
}
