import { Migration } from "@mikro-orm/migrations";

/**
 * Per-line tracking on a purchase order (2026-07-30).
 *
 * A PO ships in several boxes and each box carries specific goods, but every
 * tracking number lived in the `purchase_order.tracking` JSON array with no way
 * to say WHICH lines and HOW MANY units it carried. That is a many-to-many with
 * a quantity on it — a relation, not a document — so it moves to two tables.
 *
 * NOTE: Migration20260730230000 splits the carrier columns out of
 * `purchase_order_tracking` into `purchase_order_tracking_number`, because one
 * delivery routinely has several waybills. This migration is left as it was so
 * that a database which already ran it migrates forward normally instead of
 * needing anything dropped.
 *
 * The JSON column is deliberately LEFT IN PLACE and is not dropped here. For
 * one release it is the rollback path: reverting the code makes the old readers
 * work again against data this migration never touched. There is no dual-write;
 * trackings added after the cutover live only in these tables, which is the
 * accepted, stated cost of not paying for divergence.
 *
 * ON DELETE choices, which are the load-bearing part:
 *   tracking → purchase_order          CASCADE  (a PO's shipments die with it)
 *   allocation → tracking              CASCADE  (removing a number frees its qty)
 *   allocation → purchase_order_line   RESTRICT (a line that a shipment claims
 *                                                cannot silently disappear)
 *
 * RESTRICT is the backstop, not the user-facing behavior: the PATCH route
 * answers 409 naming the tracking, the SKU and the quantity first. It is safe
 * here because the only hard delete of PO lines in the whole backend is that
 * one route, and nothing hard-deletes a purchase order at all.
 *
 * The uniqueness of (tracking, line) is PARTIAL on `deleted_at is null`,
 * matching every other table in this module — without that, removing an
 * allocation and re-adding the same one would collide with its own tombstone.
 *
 * What is NOT a constraint: the cap (sum of a line's allocations across sibling
 * trackings <= qty_ordered - qty_cancelled). No CHECK can see sibling rows, so
 * it is enforced in the service inside a transaction.
 */
export class Migration20260730220000 extends Migration {
  async up(): Promise<void> {
    // ── purchase_order_tracking ──────────────────────────────────────────────
    this.addSql(`
      create table if not exists "purchase_order_tracking" (
        "id"                        text not null,
        "purchase_order_id"         text not null,
        "scope"                     text not null default 'all_order'
          check ("scope" in ('all_order','by_line')),
        "provider"                  text not null,
        "tracking_number"           text not null,
        "tracking_url"              text not null default '',
        "carrier_eta"               text null,
        "carrier_status"            text not null default 'pending'
          check ("carrier_status" in ('pending','in_transit','delivered','unavailable','error')),
        "carrier_eta_fetched_at"    timestamptz null,
        "carrier_detail"            text null,
        "created_by_user_id"        text null,
        "updated_by_user_id"        text null,
        "created_at"                timestamptz not null default now(),
        "updated_at"                timestamptz not null default now(),
        "deleted_at"                timestamptz null,
        constraint "purchase_order_tracking_pkey" primary key ("id"),
        constraint "FK_potrk_purchase_order_id"
          foreign key ("purchase_order_id") references "purchase_order" ("id") on delete cascade
      );
    `);
    this.addSql(
      `create index if not exists "IDX_potrk_purchase_order_id" on "purchase_order_tracking" ("purchase_order_id") where "deleted_at" is null;`
    );
    this.addSql(
      `create index if not exists "IDX_potrk_deleted_at" on "purchase_order_tracking" ("deleted_at") where "deleted_at" is null;`
    );

    // ── purchase_order_tracking_line ─────────────────────────────────────────
    this.addSql(`
      create table if not exists "purchase_order_tracking_line" (
        "id"                            text not null,
        "purchase_order_tracking_id"    text not null,
        "purchase_order_line_id"        text not null,
        "purchase_order_id"             text not null,
        "qty_allocated"                 integer not null
          check ("qty_allocated" > 0),
        "created_at"                    timestamptz not null default now(),
        "updated_at"                    timestamptz not null default now(),
        "deleted_at"                    timestamptz null,
        constraint "purchase_order_tracking_line_pkey" primary key ("id"),
        constraint "FK_potrkl_tracking_id"
          foreign key ("purchase_order_tracking_id") references "purchase_order_tracking" ("id") on delete cascade,
        constraint "FK_potrkl_purchase_order_line_id"
          foreign key ("purchase_order_line_id") references "purchase_order_line" ("id") on delete restrict,
        constraint "FK_potrkl_purchase_order_id"
          foreign key ("purchase_order_id") references "purchase_order" ("id") on delete cascade
      );
    `);
    this.addSql(
      `create unique index if not exists "UQ_potrkl_tracking_line" on "purchase_order_tracking_line" ("purchase_order_tracking_id", "purchase_order_line_id") where "deleted_at" is null;`
    );
    this.addSql(
      `create index if not exists "IDX_potrkl_purchase_order_line_id" on "purchase_order_tracking_line" ("purchase_order_line_id") where "deleted_at" is null;`
    );
    this.addSql(
      `create index if not exists "IDX_potrkl_purchase_order_id" on "purchase_order_tracking_line" ("purchase_order_id") where "deleted_at" is null;`
    );
    this.addSql(
      `create index if not exists "IDX_potrkl_deleted_at" on "purchase_order_tracking_line" ("deleted_at") where "deleted_at" is null;`
    );
  }

  async down(): Promise<void> {
    // Safe to drop outright: the JSON column this replaces was never emptied,
    // so rolling back loses only trackings created after the cutover.
    this.addSql(`drop table if exists "purchase_order_tracking_line" cascade;`);
    this.addSql(`drop table if exists "purchase_order_tracking" cascade;`);
  }
}
