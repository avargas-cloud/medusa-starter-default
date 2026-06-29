import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260629160000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE IF NOT EXISTS customer_payment_transfer (
          id                  TEXT PRIMARY KEY,
          payment_id          TEXT NOT NULL,
          from_customer_id    TEXT NOT NULL,
          to_customer_id      TEXT NOT NULL,
          amount              NUMERIC NOT NULL,
          raw_amount          JSONB NOT NULL,
          reason              TEXT,
          requested_by        TEXT NOT NULL,
          qb_old_txn_id       TEXT,
          qb_new_txn_id       TEXT,
          qb_status           TEXT NOT NULL DEFAULT 'pending',
          created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          deleted_at          TIMESTAMPTZ
      );
    `);
    this.addSql(
      `CREATE INDEX IF NOT EXISTS idx_cptr_payment ON customer_payment_transfer (payment_id);`
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS idx_cptr_from_cust ON customer_payment_transfer (from_customer_id);`
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS idx_cptr_to_cust ON customer_payment_transfer (to_customer_id);`
    );
  }

  override async down(): Promise<void> {
    this.addSql(`DROP TABLE IF EXISTS customer_payment_transfer;`);
  }
}
