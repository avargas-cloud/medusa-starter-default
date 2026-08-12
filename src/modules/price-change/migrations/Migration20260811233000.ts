import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Migration20260811233000
 *
 * Adds sequential, gapless, human-readable numbering to price_change_batch
 * (`display_number`, rendered by the frontend as `PA-<display_number>`).
 *
 * Same pattern as `document_number_counter` rows `medusa_invoice`/
 * `qb_invoice`/`qb_sales_receipt` (src/migrations/1779500000000-…): a counter
 * ROW claimed inside the SAME transaction that creates the row, never a
 * Postgres sequence (a sequence burns a number on rollback).
 *
 *   1. add the column (nullable — historical rows never get one)
 *   2. partial UNIQUE index so only assigned numbers are constrained
 *   3. backfill existing batches by created_at ASC, starting at 1001
 *   4. seed/advance the `price_change_batch` counter row so the next claim
 *      continues right after the highest backfilled number
 */
export class Migration20260811233000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table if exists "price_change_batch"
        add column if not exists "display_number" integer null;
    `);

    this.addSql(`
      create unique index if not exists "uq_price_change_batch_display_number"
        on "price_change_batch" ("display_number")
        where "display_number" is not null;
    `);

    // Backfill by created_at ASC, starting at 1001 — matches the numbering
    // start the spec calls for (mirrors how document_number_counter seeds
    // from historical MAX()).
    this.addSql(`
      with numbered as (
        select "id",
               1000 + row_number() over (order by "created_at" asc) as "n"
          from "price_change_batch"
         where "display_number" is null
      )
      update "price_change_batch" b
         set "display_number" = numbered."n"
        from numbered
       where b."id" = numbered."id";
    `);

    // Seed/advance the counter row so the NEXT claim continues where the
    // backfill left off. If the counter already exists (re-run / partial
    // deploy), advance it to the observed max instead of clobbering a value
    // that may already be ahead of it.
    this.addSql(`
      insert into "document_number_counter" ("name", "value")
      values (
        'price_change_batch',
        coalesce((select max("display_number") from "price_change_batch"), 1000)
      )
      on conflict ("name") do update
        set "value" = greatest(
          "document_number_counter"."value",
          excluded."value"
        ),
            "updated_at" = now();
    `);
  }

  override async down(): Promise<void> {
    this.addSql(
      `drop index if exists "uq_price_change_batch_display_number";`
    );
    this.addSql(
      `alter table if exists "price_change_batch" drop column if exists "display_number";`
    );
    this.addSql(
      `delete from "document_number_counter" where "name" = 'price_change_batch';`
    );
  }
}
