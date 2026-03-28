import { MigrationInterface, QueryRunner } from "typeorm"

export class CreateQbPipeline1774300000000 implements MigrationInterface {
    name = "CreateQbPipeline1774300000000"

    public async up(queryRunner: QueryRunner): Promise<void> {
        // ─── qb_order_pipeline ────────────────────────────────────────────────
        // One row per QB document step per order/reference.
        // depends_on enforces sequential execution (Invoice after Sales Order, etc.)
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS qb_order_pipeline (
                id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),

                -- What document this row belongs to
                order_id        text,           -- Medusa order ID (null for standalone credit memos)
                reference_id    text,           -- credit_memo_id, pos_invoice_id, etc.
                reference_type  text,           -- 'order' | 'credit_memo' | 'pos_invoice'

                -- The QB step to execute
                step            text NOT NULL,
                -- estimate | sales_order | sales_receipt | invoice
                -- payment | apply_payment | credit_memo | write_check

                -- Dependency: this row cannot start until depends_on row is 'confirmed'
                depends_on      uuid REFERENCES qb_order_pipeline(id) ON DELETE SET NULL,

                -- Lifecycle status
                status          text NOT NULL DEFAULT 'pending',
                -- pending | submitted | confirmed | failed | skipped

                -- Bridge operation tracking
                bridge_op_id    text,           -- operationId from bridge (set when submitted)
                retry_count     int NOT NULL DEFAULT 0,

                -- QB confirmation data (set when confirmed)
                qb_txn_id       text,
                qb_ref_number   text,
                qb_result       jsonb,          -- full QB response (never truncated)

                -- Payload sent to bridge (preserved for retry)
                payload         jsonb,

                -- Error info (set when failed)
                error           text,

                -- Timestamps
                created_at      timestamptz NOT NULL DEFAULT NOW(),
                submitted_at    timestamptz,
                confirmed_at    timestamptz,
                failed_at       timestamptz
            )
        `)

        await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_qb_pipeline_order     ON qb_order_pipeline (order_id, status)`)
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_qb_pipeline_ref       ON qb_order_pipeline (reference_id, status)`)
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_qb_pipeline_status    ON qb_order_pipeline (status, created_at DESC)`)
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_qb_pipeline_submitted ON qb_order_pipeline (bridge_op_id) WHERE bridge_op_id IS NOT NULL`)

        // ─── qb_edit_sequence_cache ───────────────────────────────────────────
        // Caches QB EditSequence per entity to avoid a double bridge round-trip
        // on every Mod (update) operation.
        // Strategy:
        //   1. Use cached value → submit Mod
        //   2. QB returns OK  → update cache with new EditSequence from response
        //   3. QB returns 3210 (conflict) → DELETE this row → re-fetch → retry
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS qb_edit_sequence_cache (
                entity_type  text        NOT NULL,   -- 'customer' | 'invoice' | 'sales_order'
                qb_id        text        NOT NULL,   -- QB ListID or TxnID
                edit_seq     text        NOT NULL,
                cached_at    timestamptz NOT NULL DEFAULT NOW(),
                PRIMARY KEY (entity_type, qb_id)
            )
        `)
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS qb_edit_sequence_cache`)
        await queryRunner.query(`DROP TABLE IF EXISTS qb_order_pipeline`)
    }
}
