import { MigrationInterface, QueryRunner } from "typeorm";

import { RECOMPUTE_ORDER_MONEY_SQL } from "../lib/order-money/recompute-sql";

/**
 * The mirror's idempotency guard treated an ABSENT metadata key as zero.
 *
 * `recompute_order_money()` only rewrites `order.metadata` when the value would
 * change, which is right — a no-op write churns `updated_at` and enqueues
 * pointless work on the order→Meili trigger. But it compared
 *
 *     round(COALESCE(NULLIF(metadata->>'applied_total', '')::numeric, 0), 2)
 *
 * against the newly computed value. When the key does not exist that COALESCE
 * yields 0, so an order whose applied total is genuinely 0 compared 0 against 0,
 * read "unchanged", and never got the key written at all.
 *
 * 325 orders in production ended up without `applied_total`, and 5 of them were
 * holding a live deposit. The damage is not cosmetic: getPaidAmount() falls back
 * to Medusa's captured amount when it cannot find applied_total, so it
 * re-derived the very money the projection had set to zero. That is the double
 * count the operator kept seeing — In Deposit and Paid Amt showing the same
 * dollars on one order, together exceeding its total.
 *
 * The guard now fires on absence as well as on difference. The function body
 * lives in lib/order-money/recompute-sql.ts so this migration and 1781600000000
 * install the same text rather than two copies that can drift.
 *
 * NOT idempotent by itself: replacing the function fixes every FUTURE recompute,
 * but the 325 rows already written stay keyless until something recomputes them.
 * Run recompute_all_order_money() after this deploys — the trigger-driven path
 * will not revisit an order that nobody touches.
 */
export class FixOrderMoneyMirrorAbsentKey1781700000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(RECOMPUTE_ORDER_MONEY_SQL);
  }

  public async down(): Promise<void> {
    // Forward-only: the previous body is the bug. Rolling back would restore a
    // guard that cannot create a key it needs, and 1781600000000's own down()
    // drops the function outright.
  }
}
