import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * cash-close-20260918 — one frozen snapshot per printed close. Never posts to
 * the GL, never touches QuickBooks: it classifies `customer_payment` /
 * `payment_application` / `pos_invoice` / `pos_credit_memo` for a business
 * day and records the result. `snapshot` is the frozen print (a reprint
 * reads this row, never recomputes); `totals` is denormalized out of it so
 * the list view (`GET /admin/pos/cash-close/records`) doesn't have to
 * deserialize the whole snapshot to show the header figures.
 *
 * A close is only ever inserted BALANCED (unbalanced days print a DRAFT the
 * route never persists) — `balanced boolean NOT NULL` exists as a documented
 * invariant, not a working state.
 *
 * New table, no data in prod for this feature: expand-only.
 */
export class CashClose20260918160000 implements MigrationInterface {
  name = "CashClose20260918160000";

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`SET LOCAL lock_timeout = '15s'`);
    await q.query(`
      CREATE TABLE IF NOT EXISTS pos_cash_close (
        id text PRIMARY KEY,
        number text UNIQUE NOT NULL,
        business_day date NOT NULL,
        balanced boolean NOT NULL,
        snapshot jsonb NOT NULL,
        totals jsonb NOT NULL,
        created_by text NOT NULL,
        created_by_name text NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        superseded_by text NULL
      )
    `);
    await q.query(
      `CREATE INDEX IF NOT EXISTS ix_pos_cash_close_business_day ON pos_cash_close (business_day)`
    );
    await q.query(
      `INSERT INTO document_number_counter (name, value) VALUES ('cash_close', 0) ON CONFLICT (name) DO NOTHING`
    );
  }

  public async down(): Promise<void> {
    throw new Error(
      "CashClose: expand-only migration; a filed close would lose its number and snapshot on rollback."
    );
  }
}
