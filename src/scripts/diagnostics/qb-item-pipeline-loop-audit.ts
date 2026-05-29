/**
 * QB item-pipeline loop & price-zeroing audit (READ-ONLY).
 *
 * Surfaces the failure modes behind the seq-120 / LUX-LR24950 incident so any
 * sibling rows are caught before they cause damage:
 *   1. STUCK — non-terminal rows older than 2h (incl. active resubmit loops that
 *      keep updated_at fresh; spotted via submit_count).
 *   2. PRICE-ZEROING SUSPECTS — mod rows whose op_payload.SalesPrice == 0 while
 *      the variant's real base price > 0 (these may have zeroed QB on dispatch).
 *   3. LEGACY MARKERS — rows still carrying a truthy __iq_* marker in op_payload
 *      (should be none after Migration20260529221500; a non-zero count means the
 *      migration backfill didn't run or new contamination appeared).
 *
 * Remediate flagged rows from the admin UI: "Re-query & resolve" (re-syncs with a
 * fresh EditSequence) or "Force fail". This script never writes.
 *
 * Run:
 *   env DATABASE_URL=$(grep ^DATABASE_URL= .env | cut -d= -f2-) \
 *     npx medusa exec ./src/scripts/diagnostics/qb-item-pipeline-loop-audit.ts
 */
import { ExecArgs } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/utils";

export default async function qbItemPipelineLoopAudit({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const knex = (container as any).resolve("__pg_connection__");

  const stuckRes = await knex.raw(
    `SELECT seq, sku, op_action, status, submit_count, recovery_mode,
            (op_payload->>'SalesPrice') AS payload_price,
            created_at, updated_at
       FROM qb_item_pipeline
      WHERE deleted_at IS NULL
        AND status NOT IN ('synced', 'failed_permanent')
        AND created_at < now() - interval '2 hours'
      ORDER BY submit_count DESC NULLS LAST, created_at ASC
      LIMIT 200`
  );
  const stuck = (stuckRes?.rows ?? stuckRes ?? []) as any[];

  const priceRes = await knex.raw(
    `SELECT p.seq, p.sku, p.status, p.qb_id,
            (p.op_payload->>'SalesPrice') AS payload_price,
            pr.amount AS real_base_price
       FROM qb_item_pipeline p
       JOIN product_variant_price_set pvps ON pvps.variant_id = p.variant_id
       JOIN price pr ON pr.price_set_id = pvps.price_set_id AND pr.price_list_id IS NULL
      WHERE p.deleted_at IS NULL
        AND p.op_action = 'mod'
        AND (p.op_payload->>'SalesPrice') = '0'
        AND pr.amount > 0
      ORDER BY p.updated_at DESC
      LIMIT 200`
  );
  const priceSuspects = (priceRes?.rows ?? priceRes ?? []) as any[];

  const legacyRes = await knex.raw(
    `SELECT count(*)::int AS n
       FROM qb_item_pipeline
      WHERE deleted_at IS NULL
        AND ( (op_payload->>'__iq_reconcile')::boolean IS TRUE
           OR (op_payload->>'__iq_pending')::boolean   IS TRUE )`
  );
  const legacyCount: number =
    (legacyRes?.rows?.[0]?.n ?? legacyRes?.[0]?.n ?? 0) as number;

  logger.info("──────────────────────────────────────────────────────────");
  logger.info(`[loop-audit] STUCK (non-terminal > 2h): ${stuck.length}`);
  for (const r of stuck) {
    logger.info(
      `  seq=${r.seq} ${r.sku} ${r.op_action}/${r.status} ` +
        `submit_count=${r.submit_count} recovery=${r.recovery_mode} ` +
        `payload_price=${r.payload_price ?? "—"} created=${r.created_at}`
    );
  }
  logger.info(`[loop-audit] PRICE-ZEROING SUSPECTS (mod SalesPrice=0, real>0): ${priceSuspects.length}`);
  for (const r of priceSuspects) {
    logger.info(
      `  seq=${r.seq} ${r.sku} status=${r.status} qb_id=${r.qb_id} ` +
        `payload_price=0 real_base_price=${r.real_base_price}`
    );
  }
  logger.info(
    `[loop-audit] LEGACY TRUTHY __iq_* MARKERS still present: ${legacyCount} ` +
      `(expected 0 after Migration20260529221500)`
  );
  logger.info("──────────────────────────────────────────────────────────");

  if (stuck.length || priceSuspects.length || legacyCount) {
    logger.warn(
      "[loop-audit] Action: remediate flagged rows via admin 'Re-query & resolve' or 'Force fail'."
    );
  } else {
    logger.info("[loop-audit] Clean — no stuck rows, price suspects, or legacy markers.");
  }
}
