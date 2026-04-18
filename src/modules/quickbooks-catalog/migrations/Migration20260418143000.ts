import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260418143000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`alter table "qb_vendor"
      add column if not exists "first_name" text null,
      add column if not exists "middle_initial" text null,
      add column if not exists "last_name" text null,
      add column if not exists "contact" text null,
      add column if not exists "alt_contact" text null,
      add column if not exists "email" text null,
      add column if not exists "phone" text null,
      add column if not exists "alt_phone" text null,
      add column if not exists "fax" text null,
      add column if not exists "addr1" text null,
      add column if not exists "addr2" text null,
      add column if not exists "city" text null,
      add column if not exists "state" text null,
      add column if not exists "postal_code" text null,
      add column if not exists "country" text null,
      add column if not exists "terms_ref_name" text null,
      add column if not exists "prefill_account_ref_name" text null,
      add column if not exists "vendor_type_ref_name" text null,
      add column if not exists "currency_ref_name" text null,
      add column if not exists "tax_identity" text null,
      add column if not exists "is_vendor_eligible_for_1099" boolean null,
      add column if not exists "credit_limit" numeric null,
      add column if not exists "notes" text null;`);

    this.addSql(
      `create index if not exists "IDX_qb_vendor_email" on "qb_vendor" ("email") where deleted_at is null;`
    );
    this.addSql(
      `create index if not exists "IDX_qb_vendor_state" on "qb_vendor" ("state") where deleted_at is null;`
    );
  }

  override async down(): Promise<void> {
    this.addSql(`drop index if exists "IDX_qb_vendor_state";`);
    this.addSql(`drop index if exists "IDX_qb_vendor_email";`);
    this.addSql(`alter table "qb_vendor"
      drop column if exists "notes",
      drop column if exists "credit_limit",
      drop column if exists "is_vendor_eligible_for_1099",
      drop column if exists "tax_identity",
      drop column if exists "currency_ref_name",
      drop column if exists "vendor_type_ref_name",
      drop column if exists "prefill_account_ref_name",
      drop column if exists "terms_ref_name",
      drop column if exists "country",
      drop column if exists "postal_code",
      drop column if exists "state",
      drop column if exists "city",
      drop column if exists "addr2",
      drop column if exists "addr1",
      drop column if exists "fax",
      drop column if exists "alt_phone",
      drop column if exists "phone",
      drop column if exists "email",
      drop column if exists "alt_contact",
      drop column if exists "contact",
      drop column if exists "last_name",
      drop column if exists "middle_initial",
      drop column if exists "first_name";`);
  }
}
