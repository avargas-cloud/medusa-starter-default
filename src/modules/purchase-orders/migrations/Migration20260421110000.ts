import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Migration20260421110000
 *
 * QuickBooks sync pipelines for purchase-orders:
 *   - qb_purchase_order_pipeline  (one row per PO — header-level PurchaseOrderAdd)
 *   - qb_item_receipt_pipeline    (one row per receipt — ItemReceiptAdd)
 *
 * Both tables carry a frozen `payload` JSON snapshot + retry counters + a
 * parallel `void_*` lifecycle mirroring the qb_inventory_adjustment_pipeline
 * convention. Void lifecycle is independent of the add lifecycle so the
 * same row can track both stages of the QB document's life.
 *
 * Kept separate from the schema migration so the QB integration can be
 * reverted without touching the primary business data tables.
 */
export class Migration20260421110000 extends Migration {
  override async up(): Promise<void> {
    // ── qb_purchase_order_pipeline ───────────────────────────────────────────
    this.addSql(`
      create table if not exists "qb_purchase_order_pipeline" (
        "id"                       text not null,
        "purchase_order_id"        text not null,
        "status"                   text not null default 'waiting'
          check ("status" in ('waiting','processing','synced','error','cancelled')),
        "qb_operation_id"          text null,
        "qb_list_id"               text null,
        "qb_txn_number"            text null,
        "payload"                  jsonb not null,
        "last_error"               text null,
        "retries"                  integer not null default 0,
        "next_retry_at"            timestamptz null,
        "synced_at"                timestamptz null,
        "void_status"              text null
          check ("void_status" is null or "void_status" in ('waiting','processing','voided','error')),
        "void_operation_id"        text null,
        "void_synced_at"           timestamptz null,
        "void_last_error"          text null,
        "void_retries"             integer not null default 0,
        "void_next_retry_at"       timestamptz null,
        "created_at"               timestamptz not null default now(),
        "updated_at"               timestamptz not null default now(),
        "deleted_at"               timestamptz null,
        constraint "qb_purchase_order_pipeline_pkey" primary key ("id"),
        constraint "FK_qbpopipe_purchase_order_id"
          foreign key ("purchase_order_id") references "purchase_order" ("id") on delete cascade
      );
    `);
    this.addSql(
      `create unique index if not exists "UQ_qbpopipe_purchase_order_id" on "qb_purchase_order_pipeline" ("purchase_order_id") where "deleted_at" is null;`
    );
    this.addSql(
      `create index if not exists "IDX_qbpopipe_status" on "qb_purchase_order_pipeline" ("status") where "deleted_at" is null;`
    );
    this.addSql(
      `create index if not exists "IDX_qbpopipe_next_retry_at" on "qb_purchase_order_pipeline" ("next_retry_at") where "status" in ('waiting','error') and "deleted_at" is null;`
    );
    this.addSql(
      `create index if not exists "IDX_qbpopipe_void_next_retry_at" on "qb_purchase_order_pipeline" ("void_next_retry_at") where "void_status" in ('waiting','error') and "deleted_at" is null;`
    );
    this.addSql(
      `create index if not exists "IDX_qbpopipe_deleted_at" on "qb_purchase_order_pipeline" ("deleted_at") where "deleted_at" is null;`
    );

    // ── qb_item_receipt_pipeline ─────────────────────────────────────────────
    this.addSql(`
      create table if not exists "qb_item_receipt_pipeline" (
        "id"                              text not null,
        "purchase_order_receipt_id"       text not null,
        "purchase_order_id"               text not null,
        "status"                          text not null default 'waiting'
          check ("status" in ('waiting','processing','synced','error','cancelled')),
        "qb_operation_id"                 text null,
        "qb_list_id"                      text null,
        "qb_txn_number"                   text null,
        "payload"                         jsonb not null,
        "last_error"                      text null,
        "retries"                         integer not null default 0,
        "next_retry_at"                   timestamptz null,
        "synced_at"                       timestamptz null,
        "void_status"                     text null
          check ("void_status" is null or "void_status" in ('waiting','processing','voided','error')),
        "void_operation_id"               text null,
        "void_synced_at"                  timestamptz null,
        "void_last_error"                 text null,
        "void_retries"                    integer not null default 0,
        "void_next_retry_at"              timestamptz null,
        "created_at"                      timestamptz not null default now(),
        "updated_at"                      timestamptz not null default now(),
        "deleted_at"                      timestamptz null,
        constraint "qb_item_receipt_pipeline_pkey" primary key ("id"),
        constraint "FK_qbrcpipe_receipt_id"
          foreign key ("purchase_order_receipt_id") references "purchase_order_receipt" ("id") on delete cascade,
        constraint "FK_qbrcpipe_purchase_order_id"
          foreign key ("purchase_order_id") references "purchase_order" ("id") on delete cascade
      );
    `);
    this.addSql(
      `create unique index if not exists "UQ_qbrcpipe_receipt_id" on "qb_item_receipt_pipeline" ("purchase_order_receipt_id") where "deleted_at" is null;`
    );
    this.addSql(
      `create index if not exists "IDX_qbrcpipe_status" on "qb_item_receipt_pipeline" ("status") where "deleted_at" is null;`
    );
    this.addSql(
      `create index if not exists "IDX_qbrcpipe_next_retry_at" on "qb_item_receipt_pipeline" ("next_retry_at") where "status" in ('waiting','error') and "deleted_at" is null;`
    );
    this.addSql(
      `create index if not exists "IDX_qbrcpipe_void_next_retry_at" on "qb_item_receipt_pipeline" ("void_next_retry_at") where "void_status" in ('waiting','error') and "deleted_at" is null;`
    );
    this.addSql(
      `create index if not exists "IDX_qbrcpipe_purchase_order_id" on "qb_item_receipt_pipeline" ("purchase_order_id") where "deleted_at" is null;`
    );
    this.addSql(
      `create index if not exists "IDX_qbrcpipe_deleted_at" on "qb_item_receipt_pipeline" ("deleted_at") where "deleted_at" is null;`
    );
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "qb_item_receipt_pipeline" cascade;`);
    this.addSql(`drop table if exists "qb_purchase_order_pipeline" cascade;`);
  }
}
