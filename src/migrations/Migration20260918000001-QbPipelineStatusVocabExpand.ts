import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * qb-pipeline-status-vocab-20260917 — EXPAND.
 *
 * One vocabulary for every `qb_*_pipeline` table and `qb_sync_log`
 * (`lib/quickbooks/pipeline-status.ts`: waiting · blocked · processing ·
 * submitted · synced · error · failed · skipped · fixed). This is the ADDITIVE
 * half of the expand/contract cutover — it runs in Railway's predeploy while
 * the OLD build is still serving, so it must accept BOTH vocabularies:
 *
 *   - the 7 purchase-family CHECKs widen to canonical + legacy
 *     (`failed_permanent`, `cancelled`, mod `completed`, void `voided`);
 *   - `qb_order_pipeline` and `qb_sync_log` get a CHECK for the first time
 *     (canonical + their legacy spellings), added NOT VALID and validated in a
 *     second statement so the scan never takes an exclusive lock on the table
 *     the three every-minute crons write;
 *   - three partial indexes on `qb_order_pipeline` get a `_v2` twin whose
 *     predicate names the canonical literals. The old ones stay until CONTRACT.
 *
 * No row is rewritten here: the conversion is a script that runs AFTER the
 * dual-read build is ACTIVE (`scripts/fix/convert-qb-pipeline-status-vocab.ts`).
 * A migration that rewrote rows while the old build still dispatched would race
 * with non-idempotent ADDs.
 *
 * `down` restores the previous CHECK lists and fails if a canonical row exists
 * — on purpose: a schema rollback with converted rows is not a rollback.
 */
export class QbPipelineStatusVocabExpand20260918000001 implements MigrationInterface {
  name = "QbPipelineStatusVocabExpand20260918000001";

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`SET LOCAL lock_timeout = '15s'`);

    const canonical = `'waiting','blocked','processing','submitted','synced','error','failed','skipped','fixed'`;

    // ── purchases family: widen ──────────────────────────────────────────
    const widen = async (table: string, col: string, legacy: string, nullable: boolean) => {
      const name = `${table}_${col}_check`;
      const list = `${canonical},${legacy}`;
      const pred = nullable
        ? `("${col}" IS NULL OR "${col}" IN (${list}))`
        : `("${col}" IN (${list}))`;
      await q.query(`ALTER TABLE "${table}" DROP CONSTRAINT IF EXISTS "${name}"`);
      await q.query(`ALTER TABLE "${table}" ADD CONSTRAINT "${name}" CHECK ${pred}`);
    };
    await widen("qb_purchase_order_pipeline", "status", `'failed_permanent','cancelled'`, false);
    await widen("qb_purchase_order_pipeline", "void_status", `'voided'`, true);
    await widen("qb_item_receipt_pipeline", "status", `'failed_permanent','cancelled'`, false);
    await widen("qb_item_receipt_pipeline", "mod_status", `'completed','failed_permanent'`, true);
    await widen("qb_item_receipt_pipeline", "void_status", `'voided'`, true);
    await widen("qb_item_pipeline", "status", `'failed_permanent'`, false);
    await widen("qb_inventory_adjustment_pipeline", "status", `'cancelled'`, false);

    // ── sales + log: first CHECK, non-blocking ───────────────────────────
    await q.query(`ALTER TABLE "qb_order_pipeline" DROP CONSTRAINT IF EXISTS "qb_order_pipeline_status_check"`);
    await q.query(`
      ALTER TABLE "qb_order_pipeline"
        ADD CONSTRAINT "qb_order_pipeline_status_check"
        CHECK ("status" IN (${canonical},'pending','confirmed','manual')) NOT VALID
    `);
    await q.query(`ALTER TABLE "qb_order_pipeline" VALIDATE CONSTRAINT "qb_order_pipeline_status_check"`);

    await q.query(`ALTER TABLE "qb_sync_log" DROP CONSTRAINT IF EXISTS "qb_sync_log_status_check"`);
    await q.query(`
      ALTER TABLE "qb_sync_log"
        ADD CONSTRAINT "qb_sync_log_status_check"
        CHECK ("status" IN (${canonical},'completed')) NOT VALID
    `);
    await q.query(`ALTER TABLE "qb_sync_log" VALIDATE CONSTRAINT "qb_sync_log_status_check"`);

    // ── sales partial indexes: canonical twins ───────────────────────────
    await q.query(`
      CREATE INDEX IF NOT EXISTS "idx_qb_pipeline_inflight_v2"
        ON "qb_order_pipeline" ("order_id", "step", "created_at" DESC)
        WHERE "status" IN ('waiting','pending','submitted')
    `);
    await q.query(`
      CREATE INDEX IF NOT EXISTS "idx_qb_pipeline_stale_pending_v2"
        ON "qb_order_pipeline" ("updated_at")
        WHERE "status" IN ('waiting','pending')
    `);
    await q.query(`
      CREATE INDEX IF NOT EXISTS "idx_qb_pipeline_retry_v2"
        ON "qb_order_pipeline" ("status", "next_retry_at")
        WHERE "status" IN ('error','failed','blocked')
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "idx_qb_pipeline_retry_v2"`);
    await q.query(`DROP INDEX IF EXISTS "idx_qb_pipeline_stale_pending_v2"`);
    await q.query(`DROP INDEX IF EXISTS "idx_qb_pipeline_inflight_v2"`);
    await q.query(`ALTER TABLE "qb_sync_log" DROP CONSTRAINT IF EXISTS "qb_sync_log_status_check"`);
    await q.query(`ALTER TABLE "qb_order_pipeline" DROP CONSTRAINT IF EXISTS "qb_order_pipeline_status_check"`);

    const restore = async (table: string, col: string, list: string, nullable: boolean) => {
      const name = `${table}_${col}_check`;
      const pred = nullable
        ? `("${col}" IS NULL OR "${col}" IN (${list}))`
        : `("${col}" IN (${list}))`;
      await q.query(`ALTER TABLE "${table}" DROP CONSTRAINT IF EXISTS "${name}"`);
      await q.query(`ALTER TABLE "${table}" ADD CONSTRAINT "${name}" CHECK ${pred}`);
    };
    await restore("qb_purchase_order_pipeline", "status", `'waiting','submitted','processing','synced','error','cancelled','failed_permanent'`, false);
    await restore("qb_purchase_order_pipeline", "void_status", `'waiting','processing','voided','error'`, true);
    await restore("qb_item_receipt_pipeline", "status", `'waiting','processing','synced','error','cancelled','failed_permanent'`, false);
    await restore("qb_item_receipt_pipeline", "mod_status", `'waiting','submitted','completed','error','failed_permanent'`, true);
    await restore("qb_item_receipt_pipeline", "void_status", `'waiting','processing','voided','error'`, true);
    await restore("qb_item_pipeline", "status", `'waiting','synced','error','failed_permanent'`, false);
    await restore("qb_inventory_adjustment_pipeline", "status", `'waiting','processing','synced','error','cancelled'`, false);
  }
}
