/**
 * Rollback for backfill-qb-invoices-goodlook.ts.
 *
 * Removes ONLY what the backfill created, located by the QB TxnIDs it stamped
 * (not by the audit file, so it also cleans partial runs). Per invoice:
 *   - qb_order_pipeline rows of the backfilled order
 *   - pos_invoice_item + pos_invoice (hard delete — snapshot rows, no readers)
 *   - the order (module soft-delete → Meili triggers/reconciler drop the doc)
 *
 * Dry-run default; APPLY=true to execute. Safe on prod ONLY for orders whose
 * metadata carries manually_imported_source of this backfill — anything else
 * is refused.
 *
 *   env APPLY=true DATABASE_URL=... DISABLE_SCHEDULED_JOBS=true npx medusa exec ./src/scripts/sync/rollback-qb-invoices-goodlook.ts
 */

import { ExecArgs } from "@medusajs/framework/types";
import { Modules } from "@medusajs/utils";

const APPLY = process.env.APPLY === "true";

const QB_TXN_IDS = [
  "185234-1736523736", // 07202
  "1852F2-1736529915", // 07204
  "1AE8E4-1764009443", // 08675
  "1B67D3-1769531407", // 18965
  "1B698D-1769615205", // 18968
];

export default async function rollbackGoodlookInvoices({ container }: ExecArgs) {
  const logger = container.resolve("logger");
  const orderModule = container.resolve(Modules.ORDER) as any;
  const pg = container.resolve("__pg_connection__") as any;

  logger.info(`Mode: ${APPLY ? "APPLY" : "DRY_RUN"}`);

  for (const txnId of QB_TXN_IDS) {
    const orders = (
      await pg.raw(
        `SELECT id, metadata->>'document_number' AS docnum,
                metadata->>'manually_imported_source' AS src
           FROM "order"
          WHERE metadata->>'qb_invoice_txn_id' = ? AND deleted_at IS NULL`,
        [txnId]
      )
    ).rows as Array<{ id: string; docnum: string; src: string | null }>;
    const invoices = (
      await pg.raw(
        `SELECT id, invoice_number, total FROM pos_invoice
          WHERE metadata->>'qb_txn_id' = ? AND deleted_at IS NULL`,
        [txnId]
      )
    ).rows as Array<{ id: string; invoice_number: string; total: string }>;

    if (!orders.length && !invoices.length) {
      logger.info(`[${txnId}] nothing to roll back`);
      continue;
    }
    const order = orders[0];
    if (order && !(order.src ?? "").includes("backfill 2026-08-26")) {
      logger.error(`[${txnId}] order ${order.id} is NOT from this backfill — refusing`);
      continue;
    }
    // Refuse if any payment was already applied to the invoice.
    for (const inv of invoices) {
      const apps = (
        await pg.raw(
          `SELECT count(*)::int AS n FROM payment_application WHERE invoice_id = ? AND deleted_at IS NULL`,
          [inv.id]
        )
      ).rows[0].n;
      if (apps > 0) {
        logger.error(`[${txnId}] invoice ${inv.id} has ${apps} payment application(s) — refusing`);
        return;
      }
    }

    logger.info(
      `[${txnId}] will remove: order=${order?.id ?? "-"} (${order?.docnum ?? "-"}) invoices=[${invoices
        .map((i) => `INV-${i.invoice_number}`)
        .join(", ")}]`
    );
    if (!APPLY) continue;

    for (const inv of invoices) {
      await pg.raw(`DELETE FROM pos_invoice_item WHERE invoice_id = ?`, [inv.id]);
      await pg.raw(`DELETE FROM pos_invoice WHERE id = ?`, [inv.id]);
      logger.info(`[${txnId}] ✅ pos_invoice ${inv.id} removed`);
    }
    if (order) {
      const del = await pg.raw(
        `DELETE FROM qb_order_pipeline WHERE order_id = ? RETURNING id`,
        [order.id]
      );
      logger.info(`[${txnId}] ✅ ${del.rows.length} pipeline row(s) removed`);
      await orderModule.deleteOrders([order.id]);
      logger.info(`[${txnId}] ✅ order ${order.id} deleted`);
    }
  }

  logger.info(APPLY ? "✅ ROLLBACK complete" : "DRY_RUN complete — APPLY=true to execute");
}
