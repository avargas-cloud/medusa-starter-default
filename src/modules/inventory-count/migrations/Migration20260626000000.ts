import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Migration20260626000000
 *
 * Adds `resulted_negative` to inventory_count_line.
 *
 * Part of the delta-invariant approval rework: the approval flow no longer
 * blocks lines whose delta would drive on-hand negative (a unit can be sold
 * before its PO receipt is recorded; QB Desktop permits negative inventory).
 * Instead the line is applied and `resulted_negative=true` flags it so a
 * persistent (non-self-healing) negative can be reviewed without halting the
 * count.
 */
export class Migration20260626000000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table "inventory_count_line"
         add column if not exists "resulted_negative" boolean not null default false;`
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `alter table "inventory_count_line"
         drop column if exists "resulted_negative";`
    );
  }
}
