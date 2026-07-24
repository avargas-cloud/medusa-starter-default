import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Cost-basis restatement substrate: `cost_restatement_run` (the manifest) and
 * `sale_cost_adjustment` (the immutable before/after record of every COGS
 * snapshot this system rewrites).
 *
 * WHY (2026-07-23): China products' `average_cost` was seeded from raw factory
 * cost instead of QuickBooks' landed average, and the vendor-bill AVCO seeded
 * its running average from 0 on a variant's first bill. Inventory on hand is
 * understated by ~$23k and 2,487 historical invoice lines carry a COGS snapshot
 * that never reflected what the goods actually cost.
 *
 * Fixing that means rewriting `pos_invoice_item.average_unit_cost` — a column
 * whose whole purpose is to be frozen at sale time. That is defensible ONLY if
 * the value it replaces survives somewhere immutable, which is what
 * `sale_cost_adjustment` is for. The customer-facing invoice never changes:
 * price, tax, totals and receivable are untouched; only the internal cost
 * annotation acquires a new approved version.
 *
 * Design notes:
 *  - A run is a named, versioned, approvable unit. Nothing rewrites a COGS
 *    snapshot outside of one, and re-running an applied run is a verified no-op
 *    rather than a second correction stacked on the first.
 *  - `original_unit_cost` is captured ONCE, on the first restatement of a line,
 *    and is never overwritten by a later run — `prior_restated_unit_cost` is
 *    what moves. That preserves "as originally posted" no matter how many times
 *    the methodology is revised.
 *  - `supersedes_adjustment_id` chains corrections instead of mutating them.
 *  - `economic_posted_at` (the date the cost is true for accounting) is separate
 *    from `recorded_at` (when we learned it). A July run correcting an April
 *    sale must not read as an April operating movement.
 *  - numeric(19,4) for unit costs. The legacy `vendor_bill_cost_log` used
 *    floats; that is not the standard going forward.
 */
export class CreateCostRestatement1780700000000 implements MigrationInterface {
  name = "CreateCostRestatement1780700000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ---------------------------------------------------------------------
    // variant_cost_event — created here IF ABSENT so this migration is
    // self-contained. A parallel effort introduced the same table at
    // 1780600000000; identical CREATE ... IF NOT EXISTS makes whichever runs
    // first the winner and the other a no-op. The ALTERs below then add the
    // columns the restatement needs on top of either version.
    // ---------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS variant_cost_event (
        id                          text PRIMARY KEY,
        product_variant_id          text        NOT NULL,
        stock_location_id           text        NULL,
        event_type                  text        NOT NULL,
        cost_field                  text        NOT NULL DEFAULT 'average_cost',
        effective_at                timestamptz NOT NULL,
        recorded_at                 timestamptz NOT NULL DEFAULT NOW(),
        event_sequence              bigserial   NOT NULL,
        previous_unit_cost          numeric(19,4) NULL,
        new_unit_cost               numeric(19,4) NULL,
        quantity_on_hand_at_event   integer       NULL,
        inventory_value_delta_cents bigint        NULL,
        source_system               text        NULL,
        source_type                 text        NULL,
        source_id                   text        NULL,
        reverses_event_id           text        NULL,
        status                      text        NOT NULL DEFAULT 'active',
        idempotency_key             text        NULL,
        metadata                    jsonb       NULL,
        created_at                  timestamptz NOT NULL DEFAULT NOW()
      )
    `);

    // Columns the restatement reconstruction needs. Separate from the base
    // shape so this runs cleanly whether or not 1780600000000 got there first.
    //  - economic_sequence: the ordering AUTHORITY. `event_sequence` is a
    //    bigserial and records INSERTION order, which is not the order the
    //    economics happened in during a replay.
    //  - accounting_posted_at: when accounting approved it, distinct from both
    //    effective_at and recorded_at.
    //  - receipt_id: without it, a cost event cannot be tied back to the
    //    physical movement that caused it.
    const costEventColumns: Array<[string, string]> = [
      ["restatement_run_id", "text NULL"],
      ["methodology_version", "text NULL"],
      ["economic_sequence", "bigint NULL"],
      ["accounting_posted_at", "timestamptz NULL"],
      ["receipt_id", "text NULL"],
      ["vendor_bill_id", "text NULL"],
      ["currency_code", "text NOT NULL DEFAULT 'usd'"],
      ["quantity_delta", "integer NULL"],
      ["cogs_true_up_cents", "bigint NOT NULL DEFAULT 0"],
      ["negative_settled_quantity", "integer NOT NULL DEFAULT 0"],
      ["supersedes_event_id", "text NULL"],
      ["reason_code", "text NULL"],
      ["created_by", "text NULL"],
    ];
    for (const [column, definition] of costEventColumns) {
      await queryRunner.query(
        `ALTER TABLE variant_cost_event ADD COLUMN IF NOT EXISTS ${column} ${definition}`
      );
    }

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_variant_cost_event_variant_effective
         ON variant_cost_event (product_variant_id, effective_at DESC, economic_sequence DESC)`
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_variant_cost_event_run
         ON variant_cost_event (restatement_run_id)`
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_variant_cost_event_idempotency
         ON variant_cost_event (idempotency_key)
       WHERE idempotency_key IS NOT NULL`
    );

    // ---------------------------------------------------------------------
    // cost_restatement_run — the manifest. One row per named correction.
    // ---------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS cost_restatement_run (
        id                    text PRIMARY KEY,
        reason                text        NOT NULL,
        methodology_version   text        NOT NULL,
        scope                 text        NOT NULL DEFAULT 'china',
        -- Every movement at or before this instant is in scope. Freezing it is
        -- what makes a dry-run and its later apply comparable.
        source_data_cutoff    timestamptz NOT NULL,
        -- The economic date the reconstruction starts from (the QuickBooks
        -- catalog load for the China restatement).
        anchor_date           timestamptz NOT NULL,
        status                text        NOT NULL DEFAULT 'draft',
        -- Hash of the frozen inputs. A dry-run and its apply MUST agree, or the
        -- source data moved underneath us and the run must be regenerated.
        input_hash            text        NULL,
        output_hash           text        NULL,
        variants_affected     integer     NOT NULL DEFAULT 0,
        cost_events_written   integer     NOT NULL DEFAULT 0,
        lines_restated        integer     NOT NULL DEFAULT 0,
        cogs_delta_cents      bigint      NOT NULL DEFAULT 0,
        inventory_delta_cents bigint      NOT NULL DEFAULT 0,
        exceptions            jsonb       NULL,
        reconciliation        jsonb       NULL,
        requested_by          text        NULL,
        approved_by           text        NULL,
        approved_at           timestamptz NULL,
        applied_at            timestamptz NULL,
        superseded_by_run_id  text        NULL,
        created_at            timestamptz NOT NULL DEFAULT NOW(),
        updated_at            timestamptz NOT NULL DEFAULT NOW(),
        CONSTRAINT chk_cost_restatement_run_status
          CHECK (status IN ('draft','approved','applied','superseded','aborted'))
      )
    `);

    // ---------------------------------------------------------------------
    // sale_cost_adjustment — the immutable before/after of every rewritten
    // COGS snapshot. This is the audit record; the column on the invoice line
    // is only the current projection of it.
    // ---------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS sale_cost_adjustment (
        id                        text PRIMARY KEY,
        restatement_run_id        text        NOT NULL,
        source_type               text        NOT NULL,
        source_line_id            text        NOT NULL,
        source_document_id        text        NULL,
        product_variant_id        text        NULL,
        sku                       text        NULL,
        quantity                  integer     NOT NULL,
        -- Captured on the FIRST restatement of a line and never rewritten by a
        -- later run. This is "as originally posted" and must survive forever.
        original_unit_cost        numeric(19,4) NULL,
        prior_restated_unit_cost  numeric(19,4) NULL,
        new_restated_unit_cost    numeric(19,4) NULL,
        original_extended_cogs    numeric(19,4) NULL,
        new_extended_cogs         numeric(19,4) NULL,
        delta_cogs                numeric(19,4) NULL,
        cost_event_id             text        NULL,
        -- Date the corrected cost is economically true for (the sale's own
        -- date), NOT the date we discovered the error.
        economic_posted_at        timestamptz NOT NULL,
        recorded_at               timestamptz NOT NULL DEFAULT NOW(),
        reason_code               text        NULL,
        -- Set when the cost came from the parent invoice line rather than the
        -- timeline: a return reverses the cost basis of the units it sends back.
        derived_from_line_id      text        NULL,
        supersedes_adjustment_id  text        NULL,
        metadata                  jsonb       NULL,
        created_at                timestamptz NOT NULL DEFAULT NOW(),
        CONSTRAINT chk_sale_cost_adjustment_source
          CHECK (source_type IN ('invoice_item','credit_memo_item'))
      )
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_sale_cost_adjustment_run
         ON sale_cost_adjustment (restatement_run_id)`
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_sale_cost_adjustment_line
         ON sale_cost_adjustment (source_type, source_line_id)`
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_sale_cost_adjustment_variant
         ON sale_cost_adjustment (product_variant_id, economic_posted_at)`
    );
    // One adjustment per line per run: a retried apply cannot double-post.
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_sale_cost_adjustment_run_line
         ON sale_cost_adjustment (restatement_run_id, source_type, source_line_id)`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS sale_cost_adjustment`);
    await queryRunner.query(`DROP TABLE IF EXISTS cost_restatement_run`);
    // variant_cost_event is intentionally NOT dropped here: it may have been
    // created by 1780600000000 and holds cost history that cannot be rebuilt.
  }
}
