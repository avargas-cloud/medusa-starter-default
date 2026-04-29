import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Migration20260429100000
 *
 * Bootstraps the inventory-transfers module:
 *   - inventory_transfer               (header + status workflow + audit fields)
 *   - inventory_transfer_line          (SKU / cost / qty snapshots)
 *   - custom_inventory_transfer_seq    (shared Postgres sequence, IT-{seq})
 *
 * Status values: draft | confirmed | shipped | received | voided
 */
export class Migration20260429100000 extends Migration {
  override async up(): Promise<void> {
    // ── sequence ─────────────────────────────────────────────────────────────
    this.addSql(
      `CREATE SEQUENCE IF NOT EXISTS "custom_inventory_transfer_seq" START 1001;`
    );

    // ── inventory_transfer ───────────────────────────────────────────────────
    this.addSql(`
      CREATE TABLE IF NOT EXISTS "inventory_transfer" (
        "id"                          TEXT NOT NULL,
        "number"                      TEXT NULL,
        "seq"                         INTEGER NULL,
        "status"                      TEXT NOT NULL DEFAULT 'draft'
          CHECK ("status" IN ('draft','confirmed','shipped','received','voided')),
        "origin_country"              TEXT NOT NULL DEFAULT 'CN',
        "destination_location_id"     TEXT NOT NULL,
        "vendor_id"                   TEXT NULL,
        "vendor_name_snapshot"        TEXT NULL,
        "linked_purchase_order_id"    TEXT NULL,
        "reference_number"            TEXT NULL,
        "notes"                       TEXT NULL,
        "expected_arrival_at"         TIMESTAMPTZ NULL,
        "total_lines"                 INTEGER NOT NULL DEFAULT 0,
        "total_units"                 INTEGER NOT NULL DEFAULT 0,
        "subtotal_cents"              INTEGER NOT NULL DEFAULT 0,
        "created_by_user_id"          TEXT NOT NULL,
        "confirmed_at"                TIMESTAMPTZ NULL,
        "confirmed_by_user_id"        TEXT NULL,
        "shipped_at"                  TIMESTAMPTZ NULL,
        "shipped_by_user_id"          TEXT NULL,
        "received_at"                 TIMESTAMPTZ NULL,
        "received_by_user_id"         TEXT NULL,
        "voided_at"                   TIMESTAMPTZ NULL,
        "voided_by_user_id"           TEXT NULL,
        "void_reason"                 TEXT NULL,
        "created_at"                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updated_at"                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "deleted_at"                  TIMESTAMPTZ NULL,
        CONSTRAINT "inventory_transfer_pkey" PRIMARY KEY ("id")
      );
    `);

    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_it_status" ON "inventory_transfer" ("status") WHERE "deleted_at" IS NULL;`
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_it_destination_location_id" ON "inventory_transfer" ("destination_location_id") WHERE "deleted_at" IS NULL;`
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_it_vendor_id" ON "inventory_transfer" ("vendor_id") WHERE "vendor_id" IS NOT NULL AND "deleted_at" IS NULL;`
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_it_created_at" ON "inventory_transfer" ("created_at" DESC) WHERE "deleted_at" IS NULL;`
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_it_deleted_at" ON "inventory_transfer" ("deleted_at") WHERE "deleted_at" IS NULL;`
    );

    // ── inventory_transfer_line ──────────────────────────────────────────────
    this.addSql(`
      CREATE TABLE IF NOT EXISTS "inventory_transfer_line" (
        "id"                    TEXT NOT NULL,
        "transfer_id"           TEXT NOT NULL,
        "product_variant_id"    TEXT NOT NULL,
        "sku"                   TEXT NOT NULL,
        "description"           TEXT NOT NULL DEFAULT '',
        "qty"                   INTEGER NOT NULL DEFAULT 1,
        "unit_cost_cents"       INTEGER NOT NULL DEFAULT 0,
        "created_at"            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updated_at"            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "deleted_at"            TIMESTAMPTZ NULL,
        CONSTRAINT "inventory_transfer_line_pkey" PRIMARY KEY ("id"),
        CONSTRAINT "FK_itl_transfer_id"
          FOREIGN KEY ("transfer_id") REFERENCES "inventory_transfer" ("id") ON DELETE CASCADE
      );
    `);

    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_itl_transfer_id" ON "inventory_transfer_line" ("transfer_id") WHERE "deleted_at" IS NULL;`
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_itl_product_variant_id" ON "inventory_transfer_line" ("product_variant_id") WHERE "deleted_at" IS NULL;`
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_itl_deleted_at" ON "inventory_transfer_line" ("deleted_at") WHERE "deleted_at" IS NULL;`
    );
  }

  override async down(): Promise<void> {
    this.addSql(`DROP TABLE IF EXISTS "inventory_transfer_line" CASCADE;`);
    this.addSql(`DROP TABLE IF EXISTS "inventory_transfer" CASCADE;`);
    this.addSql(`DROP SEQUENCE IF EXISTS "custom_inventory_transfer_seq";`);
  }
}
