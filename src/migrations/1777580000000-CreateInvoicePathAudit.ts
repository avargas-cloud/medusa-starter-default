import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Temporary 24h audit log for POST /admin/invoices.
 *
 * Captures the inputs and decision path of the Sales Receipt vs Invoice
 * downgrade logic so we can pin down why some orders end up on the Invoice
 * path when the Sales Receipt path was expected.
 *
 * Each insert into this table also runs a cleanup step that deletes rows
 * older than 24 hours — no separate cron required. Once the bug is fixed
 * and confirmed, drop this table.
 */
export class CreateInvoicePathAudit1777580000000 implements MigrationInterface {
  name = "CreateInvoicePathAudit1777580000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS qb_invoice_path_audit (
        id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        order_id                    text NOT NULL,
        invoice_id                  text,
        invoice_number              text,

        body_is_sales_receipt       boolean NOT NULL,
        final_is_sales_receipt      boolean,
        path_b_triggered            boolean NOT NULL DEFAULT false,

        has_existing_qb_doc         boolean,
        has_existing_qb_doc_keys    jsonb,
        age_ms                      bigint,
        has_pending_so_in_pipeline  boolean,

        request_body                jsonb,
        order_metadata_snapshot     jsonb,

        created_at                  timestamptz NOT NULL DEFAULT NOW()
      )
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_invoice_path_audit_created ON qb_invoice_path_audit (created_at DESC)`
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_invoice_path_audit_order ON qb_invoice_path_audit (order_id)`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS qb_invoice_path_audit`);
  }
}
