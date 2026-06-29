import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Gapless invoice numbering — Phase 2 of the idempotency initiative.
 * See docs/IDEMPOTENCY_PLAN.md (design validated with Codex).
 *
 * Replaces the non-transactional Postgres sequences (custom_medusa_invoice_seq,
 * custom_invoice_seq, custom_sales_receipt_seq) — which BURN a number on any
 * rollback/crash — with transactional counter ROWS. The invoice route locks the
 * counter row (SELECT ... FOR UPDATE), allocates `value + 1`, inserts the
 * pos_invoice in the SAME physical transaction, and only then advances the
 * counter. A rolled-back insert therefore never advances the counter → no gaps.
 *
 * Also creates `invoice_create_attempt` for request-level dedup (header
 * Idempotency-Key › terminal_payment_id › content fingerprint), claimed INSIDE
 * the same transaction before number allocation, so a double-click / retry /
 * replay returns the already-created invoice instead of minting a second one.
 *
 * Counters seeded from GREATEST(current sequence, MAX(actual rows)) so the
 * sandbox is correct immediately. NOTE: the production cutover must RE-SEED at
 * deploy time under a brief invoice-creation freeze (see plan) — sequence state
 * can drift between this migration running and the route switching over.
 */
export class CreateDocumentNumberCounters1779500000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── Counter table ──────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS document_number_counter (
        name  text PRIMARY KEY,
        value bigint NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `);

    // Seed value = last USED number = GREATEST(sequence last-used, max live row).
    // A sequence with is_called=false reports last_value = NEXT value, so subtract 1.
    const seqLastUsed = (seq: string) =>
      `(SELECT CASE WHEN is_called THEN last_value ELSE last_value - 1 END FROM ${seq})`;

    // internal invoice_number ← custom_medusa_invoice_seq + MAX(pos_invoice.invoice_number)
    await queryRunner.query(`
      INSERT INTO document_number_counter (name, value)
      VALUES (
        'medusa_invoice',
        GREATEST(
          ${seqLastUsed("custom_medusa_invoice_seq")},
          COALESCE((
            SELECT MAX((invoice_number)::bigint) FROM pos_invoice
            WHERE deleted_at IS NULL AND invoice_number ~ '^[0-9]+$'
          ), 0)
        )
      )
      ON CONFLICT (name) DO NOTHING;
    `);

    // QB invoice ref ← custom_invoice_seq + MAX(qb_ref_number where NOT sales receipt)
    await queryRunner.query(`
      INSERT INTO document_number_counter (name, value)
      VALUES (
        'qb_invoice',
        GREATEST(
          ${seqLastUsed("custom_invoice_seq")},
          COALESCE((
            SELECT MAX((metadata->>'qb_ref_number')::bigint) FROM pos_invoice
            WHERE deleted_at IS NULL
              AND metadata->>'qb_ref_number' ~ '^[0-9]+$'
              AND COALESCE(metadata->>'is_sales_receipt', 'false') <> 'true'
          ), 0)
        )
      )
      ON CONFLICT (name) DO NOTHING;
    `);

    // QB sales-receipt ref ← custom_sales_receipt_seq + MAX(qb_ref_number where sales receipt)
    await queryRunner.query(`
      INSERT INTO document_number_counter (name, value)
      VALUES (
        'qb_sales_receipt',
        GREATEST(
          ${seqLastUsed("custom_sales_receipt_seq")},
          COALESCE((
            SELECT MAX((metadata->>'qb_ref_number')::bigint) FROM pos_invoice
            WHERE deleted_at IS NULL
              AND metadata->>'qb_ref_number' ~ '^[0-9]+$'
              AND COALESCE(metadata->>'is_sales_receipt', 'false') = 'true'
          ), 0)
        )
      )
      ON CONFLICT (name) DO NOTHING;
    `);

    // ── Dedup / idempotency-claim table ────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS invoice_create_attempt (
        dedup_key    text PRIMARY KEY,
        request_hash text NOT NULL,
        invoice_id   text NULL,
        created_at   timestamptz NOT NULL DEFAULT now(),
        updated_at   timestamptz NOT NULL DEFAULT now()
      );
    `);
    // Prune lookups by age (content-fingerprint keys use a short window).
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_invoice_create_attempt_created_at
        ON invoice_create_attempt (created_at);
    `);

    // ── Hardening: unique live invoice_number (clean per preflight) ─────────
    // qb_ref_number unique index is DEFERRED — blocked by historical anomaly
    // 19487 (two paid invoices share the ref). Add after that is resolved.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_pos_invoice_invoice_number_live
        ON pos_invoice (invoice_number)
        WHERE deleted_at IS NULL AND invoice_number IS NOT NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS uq_pos_invoice_invoice_number_live;`
    );
    await queryRunner.query(`DROP TABLE IF EXISTS invoice_create_attempt;`);
    await queryRunner.query(`DROP TABLE IF EXISTS document_number_counter;`);
  }
}
