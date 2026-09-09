import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/** Banking evidence only: no financial-source tables or accounting postings. */
export class Migration20260909005000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`CREATE TABLE IF NOT EXISTS bank_deposit (
      id text PRIMARY KEY,account_id text NOT NULL REFERENCES bank_account(id) ON DELETE RESTRICT,
      revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
      status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','ready','void')),
      currency text NOT NULL,deposit_date text NOT NULL,reference text NOT NULL,memo text NOT NULL DEFAULT '',
      gross_amount text NOT NULL CHECK(gross_amount::numeric>0),
      fee_amount text NOT NULL DEFAULT '0.00' CHECK(fee_amount::numeric>=0),
      fee_account_list_id text NULL,fee_reference text NULL,fee_account_snapshot jsonb NULL,
      net_amount text NOT NULL CHECK(net_amount::numeric>0),
      created_by text NOT NULL,ready_by text NULL,ready_at timestamptz NULL,
      voided_by text NULL,voided_at timestamptz NULL,void_reason text NULL,
      created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),deleted_at timestamptz NULL,
      CONSTRAINT bank_deposit_exact_net CHECK(net_amount::numeric=gross_amount::numeric-fee_amount::numeric),
      CONSTRAINT bank_deposit_fee_evidence CHECK(fee_amount::numeric=0 OR
        (fee_account_list_id IS NOT NULL AND length(trim(COALESCE(fee_reference,'')))>0))
    );`);
    this.addSql(`CREATE TABLE IF NOT EXISTS bank_deposit_line (
      id text PRIMARY KEY,deposit_id text NOT NULL REFERENCES bank_deposit(id) ON DELETE RESTRICT,
      payment_id text NOT NULL,amount text NOT NULL CHECK(amount::numeric>0),
      source_hash text NOT NULL,payment_snapshot jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),deleted_at timestamptz NULL,
      UNIQUE(deposit_id,payment_id)
    );`);
    this
      .addSql(`CREATE INDEX IF NOT EXISTS idx_bank_deposit_line_payment ON bank_deposit_line(payment_id)
      WHERE deleted_at IS NULL;`);
    this
      .addSql(`ALTER TABLE bank_transaction_review ADD COLUMN IF NOT EXISTS matched_deposit_id text NULL
      REFERENCES bank_deposit(id) ON DELETE RESTRICT,ADD COLUMN IF NOT EXISTS deposit_snapshot jsonb NULL;`);
    this.addSql(
      `ALTER TABLE bank_transaction_review DROP CONSTRAINT IF EXISTS bank_transaction_review_mode_check;`
    );
    this
      .addSql(`ALTER TABLE bank_transaction_review ADD CONSTRAINT bank_transaction_review_mode_check
      CHECK(mode IN ('categorize','match','deposit'));`);
    this
      .addSql(`CREATE UNIQUE INDEX IF NOT EXISTS uq_bank_review_active_deposit ON bank_transaction_review(matched_deposit_id)
      WHERE matched_deposit_id IS NOT NULL AND status<>'excluded' AND deleted_at IS NULL;`);
  }
  override async down(): Promise<void> {
    this.addSql("DROP INDEX IF EXISTS uq_bank_review_active_deposit;");
    this.addSql(
      "ALTER TABLE bank_transaction_review DROP COLUMN IF EXISTS matched_deposit_id,DROP COLUMN IF EXISTS deposit_snapshot;"
    );
    this.addSql("DROP TABLE IF EXISTS bank_deposit_line;");
    this.addSql("DROP TABLE IF EXISTS bank_deposit;");
  }
}
