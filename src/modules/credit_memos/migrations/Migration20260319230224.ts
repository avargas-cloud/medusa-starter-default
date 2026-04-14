import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260319230224 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `create table if not exists "pos_credit_memo" ("id" text not null, "credit_memo_number" text not null, "order_id" text null, "invoice_id" text null, "customer_id" text null, "status" text check ("status" in ('draft', 'completed', 'voided')) not null default 'draft', "subtotal" numeric not null default 0, "discount" numeric not null default 0, "tax" numeric not null default 0, "shipping" integer not null default 0, "total" numeric not null default 0, "completed_at" timestamptz null, "voided_at" timestamptz null, "void_reason" text null, "notes" text null, "created_by" text null, "raw_subtotal" jsonb not null default '{"value":"0","precision":20}', "raw_discount" jsonb not null default '{"value":"0","precision":20}', "raw_tax" jsonb not null default '{"value":"0","precision":20}', "raw_total" jsonb not null default '{"value":"0","precision":20}', "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "pos_credit_memo_pkey" primary key ("id"));`
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_pos_credit_memo_deleted_at" ON "pos_credit_memo" ("deleted_at") WHERE deleted_at IS NULL;`
    );

    this.addSql(
      `create table if not exists "pos_credit_memo_item" ("id" text not null, "credit_memo_id" text not null, "variant_id" text null, "sku" text null, "title" text null, "description" text not null, "thumbnail" text null, "quantity" integer not null, "unit_price" numeric not null, "line_total" numeric not null, "raw_unit_price" jsonb not null, "raw_line_total" jsonb not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "pos_credit_memo_item_pkey" primary key ("id"));`
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_pos_credit_memo_item_credit_memo_id" ON "pos_credit_memo_item" ("credit_memo_id") WHERE deleted_at IS NULL;`
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_pos_credit_memo_item_deleted_at" ON "pos_credit_memo_item" ("deleted_at") WHERE deleted_at IS NULL;`
    );

    this.addSql(
      `alter table if exists "pos_credit_memo_item" add constraint "pos_credit_memo_item_credit_memo_id_foreign" foreign key ("credit_memo_id") references "pos_credit_memo" ("id") on update cascade;`
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `alter table if exists "pos_credit_memo_item" drop constraint if exists "pos_credit_memo_item_credit_memo_id_foreign";`
    );

    this.addSql(`drop table if exists "pos_credit_memo" cascade;`);

    this.addSql(`drop table if exists "pos_credit_memo_item" cascade;`);
  }
}
