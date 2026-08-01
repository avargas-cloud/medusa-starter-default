import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Item-level exclusivity for inventory counts.
 *
 * THE INVARIANT
 *   At most one unresolved count line may hold the right to apply a correction
 *   for a given (inventory_item_id, stock_location_id).
 *
 * WHY IT IS NEEDED
 *   A count stores a FROZEN delta (delta_original = counted - stock_at_submit),
 *   applied later against LIVE stock. That design is movement-invariant: real
 *   movements (sales, receipts) between submit and approve do not corrupt it.
 *
 *   It is NOT invariant against another *correction of the same discrepancy*.
 *   Two counts covering the same item each measure the whole gap, and each
 *   applies it in full:
 *
 *     A: base 5, counted 1 -> delta -4     B: base 5 (A not applied yet) -> delta -4
 *     approve A: 5 + (-4) =  1   correct
 *     approve B: 1 + (-4) = -3   WRONG, the shelf holds 1
 *
 *   Beyond stock, every approve emits an InventoryAdjustment to QuickBooks, so a
 *   duplicate books the same shrinkage twice against the adjustment account.
 *
 *   Comparing deltas for equality does NOT detect this: two counts can each
 *   measure a *part* of the same gap (A -10, a manual fix of 6, then B -4 ->
 *   applying both charges -14 for a gap of 10). Exclusivity has to be
 *   structural, not a heuristic over the numbers.
 *
 * WHY THE EXISTING GUARDS MISS IT
 *   - trg_inventory_count_recount_flag only watches counts in status 'draft',
 *     so the staleness net switches off exactly when submit freezes the delta.
 *   - The submit-time `recount_required` check compares live stock against the
 *     line snapshot; both counts snapshot the SAME correct number and pass.
 *   - cancelOpenCountsForItems() guards bulk absolute stock writes only, and is
 *     deliberately not reused here: it voids the whole foreign header and does
 *     not reverse already-applied lines.
 *
 * WHO HOLDS A CLAIM
 *   Only counts whose delta is frozen and armed: status submitted /
 *   partially_applied, line status pending / blocked. Drafts deliberately do
 *   NOT claim - an abandoned draft (INVCNT-1052 has been open since June with
 *   zero lines) would otherwise lock SKUs forever with no visible owner.
 *
 * SHAPE
 *   No surrogate id and no Medusa model on purpose. The primary key IS the
 *   invariant, so the database rejects a racing second submit even if both
 *   transactions read "no conflict" first. A Medusa model would soft-delete
 *   (deleted_at), leaving released rows occupying the unique index; this table
 *   is written through knex with real DELETEs instead.
 */
export class Migration20260801000000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table if not exists "inventory_count_item_claim" (
        "inventory_item_id"      text not null,
        "stock_location_id"      text not null,
        "inventory_count_id"     text not null,
        "inventory_count_line_id" text not null,
        "claimed_at"             timestamptz not null default now(),
        -- Stamped while an approval of this line is in flight, and cleared when
        -- it finishes. It is what makes concurrent approvals safe WITHOUT
        -- removing the row: deleting the claim to take the lock would leave the
        -- item free in the table for the length of the workflow, so a second
        -- request arriving in that window would claim it and both would apply
        -- the same delta — the lock would be the very thing it removed.
        "approving_started_at"   timestamptz null,
        constraint "inventory_count_item_claim_pkey"
          primary key ("inventory_item_id", "stock_location_id")
      );
    `);

    // One claim per line: makes a double-acquire for the same line impossible
    // and lets release-by-line be a single keyed DELETE.
    this.addSql(`
      create unique index if not exists "ux_invcnt_claim_line"
        on "inventory_count_item_claim" ("inventory_count_line_id");
    `);

    // Release-by-count (reject / void / cancel) is keyed on this.
    this.addSql(`
      create index if not exists "ix_invcnt_claim_count"
        on "inventory_count_item_claim" ("inventory_count_id");
    `);

    // Seed from counts that were already armed before this table existed.
    //
    // Overlaps exist in production today, so the seed must pick a winner
    // deterministically rather than fail: DISTINCT ON keeps the count that was
    // submitted FIRST. The loser keeps its rows untouched and simply fails the
    // approve guard, which is the intended fail-closed outcome - a human then
    // decides which count reflects the shelf.
    //
    // ORDER BY carries ic.id as a final tiebreaker so the choice is stable even
    // when two counts share a submitted_at (a non-total ORDER BY would let the
    // plan decide the winner).
    this.addSql(`
      insert into "inventory_count_item_claim"
        ("inventory_item_id", "stock_location_id", "inventory_count_id",
         "inventory_count_line_id", "claimed_at")
      select distinct on (icl.inventory_item_id, ic.stock_location_id)
             icl.inventory_item_id,
             ic.stock_location_id,
             ic.id,
             icl.id,
             now()
        from "inventory_count_line" icl
        join "inventory_count" ic on ic.id = icl.inventory_count_id
       where ic.deleted_at is null
         and icl.deleted_at is null
         and ic.voided_at is null
         and ic.status in ('submitted', 'partially_applied')
         and icl.status in ('pending', 'blocked')
       order by icl.inventory_item_id,
                ic.stock_location_id,
                ic.submitted_at asc,
                ic.id asc
      on conflict do nothing;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "inventory_count_item_claim";`);
  }
}
