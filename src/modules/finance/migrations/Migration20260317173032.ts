import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260317173032 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `create table if not exists "customer_payment" ("id" text not null, "customer_id" text not null, "source" text check ("source" in ('web', 'pos')) not null default 'pos', "type" text check ("type" in ('payment', 'refund', 'credit_memo')) not null default 'payment', "amount" numeric not null, "currency" text not null default 'usd', "method" text check ("method" in ('cash', 'check', 'card', 'ach', 'zelle', 'credit_memo', 'stripe', 'authorize_net', 'other')) not null default 'other', "reference" text null, "status" text check ("status" in ('available', 'partially_applied', 'applied', 'voided')) not null default 'available', "medusa_payment_id" text null, "medusa_refund_id" text null, "locked_order_id" text null, "received_at" timestamptz not null, "notes" text null, "created_by" text null, "raw_amount" jsonb not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "customer_payment_pkey" primary key ("id"));`
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_customer_payment_deleted_at" ON "customer_payment" ("deleted_at") WHERE deleted_at IS NULL;`
    );

    this.addSql(
      `create table if not exists "payment_application" ("id" text not null, "payment_id" text not null, "invoice_id" text null, "order_id" text not null, "amount_applied" numeric not null, "applied_at" timestamptz not null, "applied_by" text null, "voided_at" timestamptz null, "void_reason" text null, "voided_by" text null, "raw_amount_applied" jsonb not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "payment_application_pkey" primary key ("id"));`
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_payment_application_payment_id" ON "payment_application" ("payment_id") WHERE deleted_at IS NULL;`
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_payment_application_deleted_at" ON "payment_application" ("deleted_at") WHERE deleted_at IS NULL;`
    );

    this.addSql(
      `alter table if exists "payment_application" add constraint "payment_application_payment_id_foreign" foreign key ("payment_id") references "customer_payment" ("id") on update cascade;`
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `alter table if exists "payment_application" drop constraint if exists "payment_application_payment_id_foreign";`
    );

    this.addSql(`drop table if exists "customer_payment" cascade;`);

    this.addSql(`drop table if exists "payment_application" cascade;`);
  }
}
