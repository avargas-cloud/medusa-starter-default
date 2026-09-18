import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * qb-pipeline-status-vocab-20260917 — CONTRACT.
 *
 * Runs in the SECOND deploy, after `convert-qb-pipeline-status-vocab.ts`
 * rewrote every legacy row and while the code flips `VOCAB_PHASE` to
 * "contract". It narrows what EXPAND widened:
 *
 *   - purchase-family CHECKs → canonical only; `qb_vendor_pipeline` and
 *     `qb_vendor_bill_pipeline` (never had one) get the canonical CHECK;
 *   - `qb_sync_log` → canonical only;
 *   - `qb_order_pipeline` → canonical + `pending` + `manual`. `pending` stays
 *     because the EXPAND build keeps writing it for the ≤8 min of the cutover;
 *     the contract consolidator sweeps it to `waiting` and the SEAL migration
 *     (next deploy) drops it from the CHECK;
 *   - the three legacy partial indexes drop (their `_v2` twins carry the
 *     canonical predicates since EXPAND).
 *
 * FAIL-CLOSED: it refuses to run while a legacy literal still exists in any of
 * the nine tables. A failing predeploy leaves the previous build serving —
 * that is the correct outcome if the conversion was skipped.
 *
 * Lived in `src/migrations-staged/` during the EXPAND deploy so the predeploy
 * would not pick it up; phase 7 moved it here.
 */
export class QbPipelineStatusVocabContract20260918000002 implements MigrationInterface {
  name = "QbPipelineStatusVocabContract20260918000002";

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`SET LOCAL lock_timeout = '15s'`);

    const legacy: Array<[string, string, string]> = [
      // Sales `waiting` is NOT listed: since CONTRACT it is the canonical
      // dispatchable, and the EXPAND build never wrote it (pending/blocked), so
      // by the time this runs a `waiting` row can only be canonical. The
      // pre-push dry-run of the conversion script is what proves 0 legacy ones.
      ["qb_order_pipeline", "status", `'confirmed'`],
      ["qb_order_pipeline", "status", `'failed'`], // only with next_retry_at, checked below
      ["qb_purchase_order_pipeline", "status", `'failed_permanent','cancelled'`],
      ["qb_purchase_order_pipeline", "void_status", `'voided'`],
      ["qb_item_receipt_pipeline", "status", `'failed_permanent','cancelled'`],
      ["qb_item_receipt_pipeline", "mod_status", `'completed','failed_permanent'`],
      ["qb_item_receipt_pipeline", "void_status", `'voided'`],
      ["qb_vendor_bill_pipeline", "status", `'failed_permanent','cancelled'`],
      ["qb_item_pipeline", "status", `'failed_permanent','cancelled'`],
      ["qb_vendor_pipeline", "status", `'failed_permanent','cancelled'`],
      ["qb_inventory_adjustment_pipeline", "status", `'failed_permanent','cancelled'`],
      ["qb_sync_log", "status", `'completed'`],
    ];
    const leftovers: string[] = [];
    for (const [table, col, list] of legacy) {
      const extra = table === "qb_order_pipeline" && list === `'failed'` ? ` AND next_retry_at IS NOT NULL` : "";
      const rows = (await q.query(
        `SELECT count(*)::int AS n FROM "${table}" WHERE "${col}" IN (${list})${extra}`
      )) as Array<{ n: number }>;
      if (rows[0]?.n) leftovers.push(`${table}.${col} IN (${list})${extra}: ${rows[0].n}`);
    }
    if (leftovers.length) {
      throw new Error(
        `QbPipelineStatusVocabContract: legacy rows still present — run convert-qb-pipeline-status-vocab.ts first:\n  ${leftovers.join("\n  ")}`
      );
    }

    const canonical = `'waiting','blocked','processing','submitted','synced','error','failed','skipped','fixed'`;
    const narrow = async (table: string, col: string, nullable: boolean, extra = "") => {
      const name = `${table}_${col}_check`;
      const list = extra ? `${canonical},${extra}` : canonical;
      const pred = nullable ? `("${col}" IS NULL OR "${col}" IN (${list}))` : `("${col}" IN (${list}))`;
      await q.query(`ALTER TABLE "${table}" DROP CONSTRAINT IF EXISTS "${name}"`);
      await q.query(`ALTER TABLE "${table}" ADD CONSTRAINT "${name}" CHECK ${pred} NOT VALID`);
      await q.query(`ALTER TABLE "${table}" VALIDATE CONSTRAINT "${name}"`);
    };
    await narrow("qb_purchase_order_pipeline", "status", false);
    await narrow("qb_purchase_order_pipeline", "void_status", true);
    await narrow("qb_item_receipt_pipeline", "status", false);
    await narrow("qb_item_receipt_pipeline", "mod_status", true);
    await narrow("qb_item_receipt_pipeline", "void_status", true);
    await narrow("qb_item_pipeline", "status", false);
    await narrow("qb_inventory_adjustment_pipeline", "status", false);
    await narrow("qb_vendor_pipeline", "status", false);
    await narrow("qb_vendor_bill_pipeline", "status", false);
    await narrow("qb_sync_log", "status", false);
    await narrow("qb_order_pipeline", "status", false, `'pending','manual'`);

    await q.query(`DROP INDEX IF EXISTS "idx_qb_pipeline_inflight"`);
    await q.query(`DROP INDEX IF EXISTS "idx_qb_pipeline_stale_pending"`);
    await q.query(`DROP INDEX IF EXISTS "idx_qb_pipeline_retry"`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`SET LOCAL lock_timeout = '15s'`);
    const canonical = `'waiting','blocked','processing','submitted','synced','error','failed','skipped','fixed'`;
    const widen = async (table: string, col: string, legacy: string, nullable: boolean) => {
      const name = `${table}_${col}_check`;
      const list = legacy ? `${canonical},${legacy}` : canonical;
      const pred = nullable ? `("${col}" IS NULL OR "${col}" IN (${list}))` : `("${col}" IN (${list}))`;
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
    await q.query(`ALTER TABLE "qb_vendor_pipeline" DROP CONSTRAINT IF EXISTS "qb_vendor_pipeline_status_check"`);
    await q.query(`ALTER TABLE "qb_vendor_bill_pipeline" DROP CONSTRAINT IF EXISTS "qb_vendor_bill_pipeline_status_check"`);
    await widen("qb_sync_log", "status", `'completed'`, false);
    await widen("qb_order_pipeline", "status", `'pending','confirmed','manual'`, false);

    await q.query(`CREATE INDEX IF NOT EXISTS "idx_qb_pipeline_inflight" ON "qb_order_pipeline" ("order_id","step","created_at" DESC) WHERE "status" IN ('pending','submitted')`);
    await q.query(`CREATE INDEX IF NOT EXISTS "idx_qb_pipeline_stale_pending" ON "qb_order_pipeline" ("updated_at") WHERE "status" = 'pending'`);
    await q.query(`CREATE INDEX IF NOT EXISTS "idx_qb_pipeline_retry" ON "qb_order_pipeline" ("status","next_retry_at") WHERE "status" IN ('failed','waiting')`);
  }
}
