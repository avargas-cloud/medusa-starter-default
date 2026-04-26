import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Migration20260418200000
 *
 * Refactor inventory_count numbering to use the shared Postgres-sequence
 * convention used by the rest of the document family
 * (custom_estimate_seq, custom_invoice_seq, etc).
 *
 *   - drop the per-module inventory_count_sequence table
 *   - create custom_inventory_count_seq START 1000
 *   - make number/year/seq nullable on inventory_count (drafts have no number
 *     until submitted, which prevents ugly "DRAFT-{ts}" placeholders leaking
 *     into the UI)
 *   - rebuild unique indexes to ignore null rows
 *   - purge any leftover DRAFT-* rows from the placeholder era
 */
export class Migration20260418200000 extends Migration {
  override async up(): Promise<void> {
    // ── purge placeholder drafts left over from the previous schema ──────────
    this.addSql(`delete from "inventory_count" where "number" like 'DRAFT-%';`);

    // ── drop the obsolete per-module sequence table ──────────────────────────
    this.addSql(`drop table if exists "inventory_count_sequence" cascade;`);

    // ── shared postgres sequence (matches custom_estimate_seq / *_seq family)
    this.addSql(
      `create sequence if not exists "custom_inventory_count_seq" start 1000;`
    );

    // ── make number/year/seq nullable; drafts carry no number until submit ──
    this.addSql(`drop index if exists "UQ_inventory_count_number";`);
    this.addSql(`drop index if exists "UQ_inventory_count_year_seq";`);
    this.addSql(
      `alter table "inventory_count" alter column "number" drop not null;`
    );
    this.addSql(
      `alter table "inventory_count" alter column "year" drop not null;`
    );
    this.addSql(
      `alter table "inventory_count" alter column "seq" drop not null;`
    );
    this.addSql(
      `create unique index if not exists "UQ_inventory_count_number" on "inventory_count" ("number") where "number" is not null and "deleted_at" is null;`
    );
    this.addSql(
      `create unique index if not exists "UQ_inventory_count_seq" on "inventory_count" ("seq") where "seq" is not null and "deleted_at" is null;`
    );
  }

  override async down(): Promise<void> {
    this.addSql(`drop index if exists "UQ_inventory_count_seq";`);
    this.addSql(`drop index if exists "UQ_inventory_count_number";`);
    this.addSql(`drop sequence if exists "custom_inventory_count_seq";`);
    // Re-creating the module table on a downgrade is intentionally skipped:
    // a downgrade from this migration is not expected in production.
  }
}
