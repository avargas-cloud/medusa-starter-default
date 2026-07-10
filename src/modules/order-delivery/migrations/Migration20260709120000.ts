import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Migration20260709120000
 *
 * Bootstraps the order-delivery module: one row per outbound customer
 * shipment (bought label / courier dispatch). Status is a text column (no
 * Postgres ENUM, module convention) constrained to the DeliveryStatus state
 * machine of lib/shipping-dispatch/status.ts.
 *
 * Indexes:
 *  - order_id lookup (order detail / aggregation into Meili).
 *  - Partial "active" index for the poll cron: rows whose status is not
 *    terminal (delivered/canceled) are the only ones the 6h job scans.
 *  - UNIQUE partial on idempotency_key: a create-shipment retry with the
 *    same key must find the existing row instead of minting a second label.
 */
export class Migration20260709120000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table if not exists "order_delivery" (
        "id"                    text not null,
        "order_id"              text not null,
        "fulfillment_id"        text null,
        "invoice_id"            text null,
        "provider"              text not null
          check ("provider" in ('shippo','ups','uber')),
        "provider_object_id"    text null,
        "carrier"               text null,
        "tracking_number"       text null,
        "tracking_url"          text null,
        "label_url"             text null,
        "service"               text null,
        "rate_amount_cents"     integer null,
        "status"                text not null default 'label_created'
          check ("status" in (
            'label_created','pending_pickup','in_transit','out_for_delivery',
            'delivered','exception','failed','canceled'
          )),
        "status_detail"         text null,
        "shipped_at"            timestamptz null,
        "delivered_at"          timestamptz null,
        "voided_at"             timestamptz null,
        "status_checked_at"     timestamptz null,
        "idempotency_key"       text null,
        "created_by_user_id"    text null,
        "metadata"              jsonb null,
        "created_at"            timestamptz not null default now(),
        "updated_at"            timestamptz not null default now(),
        "deleted_at"            timestamptz null,
        constraint "order_delivery_pkey" primary key ("id")
      );
    `);
    this.addSql(
      `create index if not exists "IDX_order_delivery_order_id" on "order_delivery" ("order_id") where deleted_at is null;`
    );
    this.addSql(
      `create index if not exists "IDX_order_delivery_active" on "order_delivery" ("status") where deleted_at is null and status not in ('delivered','canceled');`
    );
    this.addSql(
      `create unique index if not exists "UQ_order_delivery_idempotency_key" on "order_delivery" ("idempotency_key") where deleted_at is null and idempotency_key is not null;`
    );
    this.addSql(
      `create index if not exists "IDX_order_delivery_deleted_at" on "order_delivery" ("deleted_at") where deleted_at is null;`
    );
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "order_delivery" cascade;`);
  }
}
