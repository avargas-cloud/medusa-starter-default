import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260312181914 extends Migration {
  override async up(): Promise<void> {
    // ── invoice_payment (new table for payment ledger) ──────────────────────
    this.addSql(`
      create table if not exists "invoice_payment" (
        "id"             text not null,
        "invoice_id"     text not null,
        "amount"         numeric not null,
        "raw_amount"     jsonb not null,
        "payment_method" text not null,
        "paid_at"        timestamptz not null default now(),
        "notes"          text null,
        "created_by"     text null,
        "created_at"     timestamptz not null default now(),
        "updated_at"     timestamptz not null default now(),
        "deleted_at"     timestamptz null,
        constraint "invoice_payment_pkey" primary key ("id")
      );
    `);
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_invoice_payment_invoice_id" ON "invoice_payment" ("invoice_id") WHERE deleted_at IS NULL;`
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_invoice_payment_deleted_at" ON "invoice_payment" ("deleted_at") WHERE deleted_at IS NULL;`
    );

    // ── pos_invoice ──────────────────────────────────────────────────────────
    this.addSql(`
      create table if not exists "pos_invoice" (
        "id"             text not null,
        "invoice_number" text not null,
        "order_id"       text not null,
        "fulfillment_id" text null,
        "customer_id"    text not null,
        "status"         text check ("status" in ('draft','issued','partial','paid','voided')) not null default 'issued',
        "subtotal"       numeric not null,
        "tax"            numeric not null,
        "total"          numeric not null,
        "amount_paid"    numeric not null,
        "balance_due"    numeric not null,
        "payment_method" text check ("payment_method" in ('cash','check','card','ach','credit','mixed')) not null,
        "issued_at"      timestamptz null,
        "paid_at"        timestamptz null,
        "voided_at"      timestamptz null,
        "void_reason"    text null,
        "notes"          text null,
        "created_by"     text null,
        "raw_subtotal"   jsonb not null,
        "raw_tax"        jsonb not null,
        "raw_total"      jsonb not null,
        "raw_amount_paid" jsonb not null,
        "raw_balance_due" jsonb not null,
        "created_at"     timestamptz not null default now(),
        "updated_at"     timestamptz not null default now(),
        "deleted_at"     timestamptz null,
        constraint "pos_invoice_pkey" primary key ("id")
      );
    `);
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_pos_invoice_deleted_at" ON "pos_invoice" ("deleted_at") WHERE deleted_at IS NULL;`
    );

    // ── invoice_tracking ────────────────────────────────────────────────────
    this.addSql(`
      create table if not exists "invoice_tracking" (
        "id"              text not null,
        "invoice_id"      text not null,
        "carrier"         text null,
        "tracking_number" text not null,
        "tracking_url"    text null,
        "shipped_at"      timestamptz null,
        "email_sent_at"   timestamptz null,
        "created_at"      timestamptz not null default now(),
        "updated_at"      timestamptz not null default now(),
        "deleted_at"      timestamptz null,
        constraint "invoice_tracking_pkey" primary key ("id")
      );
    `);
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_invoice_tracking_invoice_id" ON "invoice_tracking" ("invoice_id") WHERE deleted_at IS NULL;`
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_invoice_tracking_deleted_at" ON "invoice_tracking" ("deleted_at") WHERE deleted_at IS NULL;`
    );

    // ── pos_invoice_item ────────────────────────────────────────────────────
    this.addSql(`
      create table if not exists "pos_invoice_item" (
        "id"          text not null,
        "invoice_id"  text not null,
        "variant_id"  text null,
        "sku"         text null,
        "description" text not null,
        "quantity"    integer not null,
        "unit_price"  numeric not null,
        "total"       numeric not null,
        "raw_unit_price" jsonb not null,
        "raw_total"   jsonb not null,
        "created_at"  timestamptz not null default now(),
        "updated_at"  timestamptz not null default now(),
        "deleted_at"  timestamptz null,
        constraint "pos_invoice_item_pkey" primary key ("id")
      );
    `);
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_pos_invoice_item_invoice_id" ON "pos_invoice_item" ("invoice_id") WHERE deleted_at IS NULL;`
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_pos_invoice_item_deleted_at" ON "pos_invoice_item" ("deleted_at") WHERE deleted_at IS NULL;`
    );

    // ── Foreign keys ─────────────────────────────────────────────────────────
    this.addSql(
      `alter table if exists "invoice_tracking" add constraint "invoice_tracking_invoice_id_foreign" foreign key ("invoice_id") references "pos_invoice" ("id") on update cascade;`
    );
    this.addSql(
      `alter table if exists "pos_invoice_item" add constraint "pos_invoice_item_invoice_id_foreign" foreign key ("invoice_id") references "pos_invoice" ("id") on update cascade;`
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `alter table if exists "invoice_tracking" drop constraint if exists "invoice_tracking_invoice_id_foreign";`
    );
    this.addSql(
      `alter table if exists "pos_invoice_item" drop constraint if exists "pos_invoice_item_invoice_id_foreign";`
    );
    this.addSql(`drop table if exists "invoice_payment" cascade;`);
    this.addSql(`drop table if exists "pos_invoice" cascade;`);
    this.addSql(`drop table if exists "invoice_tracking" cascade;`);
    this.addSql(`drop table if exists "pos_invoice_item" cascade;`);
  }
}
