import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Migration20260420200000
 *
 * Add shared Postgres sequence + friendly numbering (UMD-NNNN) to
 * unmet_demand_record. Follows the same convention as estimates,
 * invoices, inventory counts: one sequence per document kind, start 1000.
 */
export class Migration20260420200000 extends Migration {
  override async up(): Promise<void> {
    // Shared postgres sequence (matches custom_estimate_seq / *_seq family)
    this.addSql(
      `create sequence if not exists "custom_unmet_demand_seq" start 1000;`
    );

    // Add nullable columns — old rows won't have a number; new rows always do
    this.addSql(
      `alter table "unmet_demand_record" add column if not exists "number" text null;`
    );
    this.addSql(
      `alter table "unmet_demand_record" add column if not exists "seq" integer null;`
    );
    this.addSql(
      `alter table "unmet_demand_record" add column if not exists "year" integer null;`
    );

    this.addSql(
      `create unique index if not exists "UQ_umdrec_number" on "unmet_demand_record" ("number") where "number" is not null and "deleted_at" is null;`
    );
    this.addSql(
      `create unique index if not exists "UQ_umdrec_seq" on "unmet_demand_record" ("seq") where "seq" is not null and "deleted_at" is null;`
    );
  }

  override async down(): Promise<void> {
    this.addSql(`drop index if exists "UQ_umdrec_seq";`);
    this.addSql(`drop index if exists "UQ_umdrec_number";`);
    this.addSql(
      `alter table "unmet_demand_record" drop column if exists "year";`
    );
    this.addSql(
      `alter table "unmet_demand_record" drop column if exists "seq";`
    );
    this.addSql(
      `alter table "unmet_demand_record" drop column if exists "number";`
    );
    this.addSql(`drop sequence if exists "custom_unmet_demand_seq";`);
  }
}
