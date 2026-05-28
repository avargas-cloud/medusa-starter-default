import { Migration } from "@mikro-orm/migrations";

/**
 * Adds a stable autoincrement `seq` to qb_item_receipt_pipeline so the QB
 * Purchase tab can render a permanent, queryable `#` (shown as `R#<seq>`) for
 * ItemReceipt rows — matching the seq convention already used by every other
 * QB pipeline table. Additive only; `serial` backfills existing rows.
 */
export class Migration20260528000001 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table if exists "qb_item_receipt_pipeline" add column if not exists "seq" bigserial;`
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `alter table if exists "qb_item_receipt_pipeline" drop column if exists "seq";`
    );
  }
}
