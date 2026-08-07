import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Findings of the REVERSE void audit: documents alive (and often paid) in the
 * POS whose QuickBooks document was voided or deleted OUTSIDE the pipeline.
 *
 * The direct direction (voided in POS, still alive in QB) is covered by
 * `qb-void-reconciler` from the database alone. This direction cannot be — the
 * database has no signal that QB diverged, which is exactly how POS Invoice
 * 21281 stayed invisible for ~24h after its QB doc was voided by a buggy
 * sibling void. Detection requires reading QuickBooks, so findings need a
 * durable home the daily digest can re-report from until a human resolves
 * them (same reasoning as `vendor_bill.qb_missing_in_qb_at`).
 *
 * One row per (qb_txn_id, kind). `resolved_at` is stamped by a human decision
 * only — the sweep never resolves its own findings.
 */
export class CreateQbReverseVoidFinding1782300000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS qb_reverse_void_finding (
        id              bigserial   PRIMARY KEY,
        doc_type        text        NOT NULL,
        reference_id    text,
        order_id        text,
        medusa_ref      text,
        qb_txn_id       text        NOT NULL,
        qb_ref_number   text,
        kind            text        NOT NULL,
        qb_time_event   timestamptz,
        pos_total_cents bigint,
        first_seen_at   timestamptz NOT NULL DEFAULT now(),
        last_seen_at    timestamptz NOT NULL DEFAULT now(),
        resolved_at     timestamptz,
        resolved_note   text,

        CONSTRAINT "CHK_qb_reverse_void_finding_kind"
          CHECK (kind IN ('deleted', 'voided')),
        CONSTRAINT "UQ_qb_reverse_void_finding_txn_kind"
          UNIQUE (qb_txn_id, kind)
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_qb_reverse_void_finding_open"
        ON qb_reverse_void_finding (first_seen_at ASC)
        WHERE resolved_at IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS qb_reverse_void_finding`);
  }
}
