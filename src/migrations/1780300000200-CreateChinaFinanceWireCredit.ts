import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * China Finance — CONSUMING an overpay credit on a future wire.
 *
 * A credit is born DERIVED (a confirmed wire's `applied_cents` exceeds the
 * since-corrected bill `amount_cents`) and is never materialised as a balance.
 * This table records its CONSUMPTION: a green credit line inside a scheduled
 * wire that reduces the cash to send (`wire_amount_cents` drops by the same
 * amount when the line is added, restored if removed while still draft).
 *
 * Snapshot columns freeze the state at apply time so the explanation shown to
 * the purchasing agent keeps describing what actually happened even if the
 * source bill changes again later.
 *
 * Accounting invariant (Codex-reviewed): the global balance formula
 * (confirmed received − total bills) is NOT touched — the overpay already
 * lives in it. Consuming the credit lowers a future wire's cash, which zeroes
 * the balance out naturally. Adding the credit to the balance again would
 * double-count.
 */
export class CreateChinaFinanceWireCredit1780300000200
  implements MigrationInterface
{
  name = "CreateChinaFinanceWireCredit1780300000200";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS china_finance_wire_credit (
        id                               text PRIMARY KEY,
        wire_transfer_id                 text NOT NULL REFERENCES china_wire_transfer(id) ON DELETE CASCADE,
        source_bill_id                   text NOT NULL REFERENCES china_finance_bill(id),
        amount_cents                     integer NOT NULL CHECK (amount_cents > 0),
        note                             text NULL,
        source_bill_amount_cents_at_apply integer NULL,
        source_applied_cents_at_apply     integer NULL,
        source_wire_sent_date_at_apply    date NULL,
        created_by_user_id               text NULL,
        created_at                       timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS IDX_cfwc_wire_transfer_id
        ON china_finance_wire_credit (wire_transfer_id)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS IDX_cfwc_source_bill_id
        ON china_finance_wire_credit (source_bill_id)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS china_finance_wire_credit`);
  }
}
