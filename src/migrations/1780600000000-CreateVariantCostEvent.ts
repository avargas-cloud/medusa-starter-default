import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * `variant_cost_event` — an append-only history of every change to a variant's
 * carrying cost.
 *
 * WHY (2026-07-23): `product_variant.metadata.average_cost` is a MUTABLE JSONB
 * key. Every writer overwrites it in place, so the previous value is destroyed
 * the moment it changes. That has two consequences:
 *
 *   1. There is no way to value inventory as of a past date. The Supply Chain
 *      report reconstructs historical QUANTITIES exactly (from invoices, credit
 *      memos, receipts and counts) but has to value every one of them at
 *      TODAY's cost, because today's cost is the only one that exists. The gap
 *      that produces was showing up on the page as a "cost-basis difference"
 *      line: +$5,160 on ~$80k of June 2026 inventory.
 *
 *   2. Worse, it is silently anachronistic. The only QuickBooks average-cost
 *      sync that has ever run happened 2026-07-17 and changed 118 SKUs — so
 *      June's inventory is being valued with costs that did not exist until
 *      mid-July. The pre-sync costs are simply gone.
 *
 * The China side already got this right: `vendor_bill_cost_log` records
 * prev_avg_cost -> new_avg_cost with an applied_at for every vendor-bill
 * confirm. This table generalises that shape to EVERY cost writer and every
 * location, so the same reconstruction becomes possible for USA product.
 *
 * This migration is the irreversible half of the work: every day it is not in
 * place is a day of cost history that cannot be recovered afterwards by any
 * means. Wiring the remaining writers, month-close snapshots, and the report
 * read-path can all follow later — this cannot.
 *
 * Design notes:
 *  - `effective_at` (when the cost became true for accounting) is deliberately
 *    separate from `recorded_at` (when we learned about it). A QuickBooks sync
 *    run in July that reflects a June transaction must not be reported as a
 *    June operating movement.
 *  - `inventory_value_delta_cents` is stored EXPLICITLY, never inferred later
 *    from a quantity that may have moved since.
 *  - numeric(19,4) for unit costs, not double precision. `vendor_bill_cost_log`
 *    used floats; that is not the standard going forward.
 *  - Append-only: a reversal inserts a compensating row pointing at
 *    `reverses_event_id` and flips the original's `status`. Rows are never
 *    updated in place or deleted.
 *  - `idempotency_key` makes a retried sync/confirm a no-op instead of applying
 *    the same transition twice.
 */
export class CreateVariantCostEvent1780600000000 implements MigrationInterface {
  name = "CreateVariantCostEvent1780600000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS variant_cost_event (
        id                          text PRIMARY KEY,
        product_variant_id          text        NOT NULL,
        -- NULL = the cost applies to the variant globally (today's
        -- average_cost is a per-variant field, not per-location). Kept so a
        -- future per-location cost basis does not need a new table.
        stock_location_id           text        NULL,

        -- qb_sync | vendor_bill_confirm | vendor_bill_cancel |
        -- vendor_bill_reopen | manual_correction | opening_balance | migration
        event_type                  text        NOT NULL,
        -- average_cost | purchase_cost — which canonical field moved.
        cost_field                  text        NOT NULL DEFAULT 'average_cost',

        effective_at                timestamptz NOT NULL,
        recorded_at                 timestamptz NOT NULL DEFAULT NOW(),
        -- Tie-breaker: several events can share an effective_at, and
        -- reconstruction has to replay them in a deterministic order.
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

    // The reconstruction's hot path: "what was this variant's cost as of D?"
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_variant_cost_event_variant_effective
         ON variant_cost_event (product_variant_id, effective_at DESC, event_sequence DESC)`
    );
    // Period-wide sweeps: "every cost change in this month" (the revaluation
    // line of the Supply Chain walk).
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_variant_cost_event_effective
         ON variant_cost_event (effective_at)`
    );
    // Tracing a row back to what caused it.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_variant_cost_event_source
         ON variant_cost_event (source_type, source_id)`
    );
    // Retry safety. Partial so rows without a key (backfills) are unconstrained.
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_variant_cost_event_idempotency
         ON variant_cost_event (idempotency_key)
       WHERE idempotency_key IS NOT NULL`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS variant_cost_event`);
  }
}
