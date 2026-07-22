/**
 * src/jobs/qb-drift-detector.ts
 *
 * READ-ONLY backstop for the purchasing-side QB pipeline (item receipts + POs).
 * It NEVER writes — it only surfaces divergence so an operator (or a future
 * auto-repair) can act. This is the global safety net for the class of bug
 * behind the RM5 / PO-1081 incident: a Medusa edit that never reached QB.
 *
 * Three signals per tick (logged as a warning digest only when non-empty):
 *   1. Item-receipt SILENT qty drift — receipt looks synced but the qty QB holds
 *      (last-sent payload) no longer matches the live receipt line. This is the
 *      quiet one that reconcile-on-confirm now prevents going forward, but this
 *      catches history, manual QB edits, and anything that slips the window.
 *   2. Item-receipt STUCK rows — ADD/MOD/VOID lane in 'failed_permanent'.
 *   3. Purchase-order STUCK rows — pipeline row in 'failed_permanent'.
 *
 * Auto-repair is deliberately NOT done here (Codex guidance): start read-only,
 * decide later whether auto-repair is safe. Reconcile-on-confirm already covers
 * the forward path; this is visibility for everything else.
 */

import { MedusaContainer } from "@medusajs/framework/types";

import {
  computeReceiptDrift,
  type KnexRaw,
} from "../lib/purchase-orders/item-receipt-mod-payload";
import { isScheduledJobsDisabled } from "./_lib/_scheduled-jobs-guard";

const TAG = "[qb-drift-detector]";

export default async function qbDriftDetector(container: MedusaContainer) {
  if (isScheduledJobsDisabled(container)) return;

  const logger = container.resolve("logger") as {
    warn: (m: string) => void;
    info: (m: string) => void;
  };
  const knex = (container as unknown as {
    resolve: (k: string) => KnexRaw & {
      raw: (sql: string) => Promise<{ rows: unknown[] }>;
    };
  }).resolve("__pg_connection__");

  try {
    // 1 — silent item-receipt qty drift (last-sent payload vs live)
    const drift = await computeReceiptDrift(knex);

    // 2 — stuck item-receipt lanes
    const stuckReceipts = (
      await knex.raw(
        `SELECT pr.number,
                p.status AS add_status, p.mod_status, p.void_status,
                LEFT(COALESCE(p.last_error, p.mod_last_error, p.void_last_error, ''), 120) AS err
           FROM qb_item_receipt_pipeline p
           JOIN purchase_order_receipt pr ON pr.id = p.purchase_order_receipt_id
          WHERE p.deleted_at IS NULL
            AND (p.status = 'failed_permanent'
                 OR p.mod_status = 'failed_permanent'
                 OR p.void_status = 'failed_permanent')`
      )
    ).rows as Array<{
      number: string;
      add_status: string;
      mod_status: string | null;
      void_status: string | null;
      err: string;
    }>;

    // 3 — stuck purchase-order rows
    const stuckPos = (
      await knex.raw(
        `SELECT po.number, LEFT(COALESCE(p.last_error, ''), 120) AS err
           FROM qb_purchase_order_pipeline p
           JOIN purchase_order po ON po.id = p.purchase_order_id
          WHERE p.deleted_at IS NULL
            AND p.status = 'failed_permanent'`
      )
    ).rows as Array<{ number: string; err: string }>;

    if (drift.length === 0 && stuckReceipts.length === 0 && stuckPos.length === 0) {
      return; // clean — stay quiet
    }

    const parts: string[] = [];
    if (drift.length > 0) {
      const sample = drift
        .slice(0, 10)
        .map(
          (d) =>
            `${d.receipt_number}[${d.lines.map((l) => `${l.sku} QB${l.qb_qty}!=live${l.live_qty}`).join(", ")}]`
        )
        .join("; ");
      parts.push(
        `${drift.length} receipt(s) with SILENT qty drift (QB != Medusa): ${sample}${drift.length > 10 ? " …" : ""}`
      );
    }
    if (stuckReceipts.length > 0) {
      const sample = stuckReceipts
        .slice(0, 10)
        .map((r) => `${r.number}(add=${r.add_status},mod=${r.mod_status ?? "-"},void=${r.void_status ?? "-"})`)
        .join(", ");
      parts.push(
        `${stuckReceipts.length} receipt pipeline row(s) failed_permanent: ${sample}${stuckReceipts.length > 10 ? " …" : ""}`
      );
    }
    if (stuckPos.length > 0) {
      const sample = stuckPos.slice(0, 10).map((p) => p.number).join(", ");
      parts.push(
        `${stuckPos.length} PO pipeline row(s) failed_permanent: ${sample}${stuckPos.length > 10 ? " …" : ""}`
      );
    }

    logger.warn(`${TAG} QB↔Medusa divergence detected — ${parts.join(" | ")}`);
  } catch (err) {
    logger.warn(
      `${TAG} scan failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

export const config = {
  name: "qb-drift-detector",
  schedule: "*/15 * * * *",
};
