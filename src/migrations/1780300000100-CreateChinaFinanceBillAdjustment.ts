import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * China Finance — audit trail for a PIN-gated edit of a vendor bill that is
 * ALREADY PAID by a confirmed wire.
 *
 * Editing such a bill is normally refused (the money is gone, the document is
 * settled). Under a supervisor PIN it is allowed, because the agent does issue
 * revised invoices and the receipt is the physical truth. The edit lowers the
 * bill's liability while the wire application stays immutable, so the delta
 * engine turns the difference into an overpay CREDIT.
 *
 * This table records WHY that credit exists — the per-line before/after — so the
 * credit can be explained to the purchasing agent instead of appearing as an
 * unexplained number. It is provenance only: the credit itself stays DERIVED
 * (`applied_cents − amount_cents`), never materialised as a balance.
 */
export class CreateChinaFinanceBillAdjustment1780300000100
  implements MigrationInterface
{
  name = "CreateChinaFinanceBillAdjustment1780300000100";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS china_finance_bill_adjustment (
        id                    text PRIMARY KEY,
        vendor_bill_id        text NOT NULL REFERENCES vendor_bill(id) ON DELETE CASCADE,
        china_finance_bill_id text NULL REFERENCES china_finance_bill(id) ON DELETE SET NULL,
        previous_total_cents  integer NOT NULL,
        new_total_cents       integer NOT NULL,
        delta_cents           integer NOT NULL,
        -- [{sku, from_qty, to_qty, from_unit_cost_cents, to_unit_cost_cents, delta_cents}]
        line_changes          jsonb NOT NULL DEFAULT '[]'::jsonb,
        -- Operator-facing sentence generated at edit time; frozen so it keeps
        -- describing what actually happened even if the bill changes again.
        note                  text NULL,
        reason                text NULL,
        created_by_user_id    text NULL,
        created_at            timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS IDX_cfba_vendor_bill_id
        ON china_finance_bill_adjustment (vendor_bill_id)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS IDX_cfba_china_finance_bill_id
        ON china_finance_bill_adjustment (china_finance_bill_id)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS china_finance_bill_adjustment`
    );
  }
}
