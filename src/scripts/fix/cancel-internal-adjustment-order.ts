/**
 * Cancela una orden de AJUSTE INTERNO (backfill-qb-reconciliation-adjustments)
 * cuya factura ya fue anulada — o sea, un ajuste que quedó muerto en /orders.
 *
 *   env DATABASE_URL=... DISABLE_SCHEDULED_JOBS=true \
 *     ./node_modules/.bin/medusa exec ./src/scripts/fix/cancel-internal-adjustment-order.ts
 *   ORDER=3359   display_id de la orden (obligatorio)
 *   APPLY=true   para ejecutar (dry-run por default)
 *
 * ── Por qué existe ───────────────────────────────────────────────────────────
 * S11722 (display 3359) compensaba la factura QB 18810 por −$74,10. El 2026-09-16
 * la paridad AR/AP anuló su factura 21702 (18810 ya cuadraba), y el void canceló
 * el fulfillment que `fulfill-backfilled-qb-orders` le había dado el 09-09. La
 * orden quedó `pending` + not_fulfilled: exactamente el predicado de la pestaña
 * Open, aunque no hay nada que vender ni cobrar.
 *
 * Es el caso 1 de `POST /admin/orders/:id/toggle-close` (sin facturas activas →
 * cancel nativo). Se reproduce acá porque un script no tiene token de admin.
 *
 * ── Guards (fail-closed) ─────────────────────────────────────────────────────
 *   - `metadata.is_internal_adjustment = true` y `never_sync_to_qb = true`
 *   - status `pending`
 *   - TODAS sus pos_invoice están `voided` (ninguna activa)
 *   - sin payment_collection con pagos, sin fulfillment vivo, sin reservas vivas
 *   - sin TxnID de QB en metadata (el subscriber de order.canceled no encola nada)
 */

import type { ExecArgs } from "@medusajs/framework/types";
import { cancelOrderWorkflow } from "@medusajs/core-flows";

const APPLY = process.env.APPLY === "true";
const DISPLAY_ID = Number(process.env.ORDER ?? "");

type Row = Record<string, unknown>;

export default async function cancelInternalAdjustmentOrder({ container }: ExecArgs): Promise<void> {
  const logger = container.resolve("logger");
  const pg = container.resolve("__pg_connection__") as { raw: (sql: string, b?: unknown[]) => Promise<{ rows: Row[] }> };

  if (!Number.isInteger(DISPLAY_ID) || DISPLAY_ID <= 0) throw new Error("ORDER=<display_id> es obligatorio");

  const { rows } = await pg.raw(
    `SELECT o.id, o.status, o.metadata,
            (SELECT count(*)::int FROM pos_invoice i WHERE i.order_id = o.id AND i.deleted_at IS NULL AND i.status <> 'voided') AS active_invoices,
            (SELECT count(*)::int FROM pos_invoice i WHERE i.order_id = o.id AND i.deleted_at IS NULL) AS invoices,
            (SELECT count(*)::int FROM order_payment_collection opc JOIN payment p ON p.payment_collection_id = opc.payment_collection_id WHERE opc.order_id = o.id AND p.deleted_at IS NULL) AS payments,
            (SELECT count(*)::int FROM order_fulfillment ofl JOIN fulfillment f ON f.id = ofl.fulfillment_id WHERE ofl.order_id = o.id AND ofl.deleted_at IS NULL AND f.canceled_at IS NULL AND f.deleted_at IS NULL) AS live_fulfillments,
            (SELECT count(*)::int FROM reservation_item r JOIN order_line_item li ON li.id = r.line_item_id JOIN order_item oi ON oi.item_id = li.id WHERE oi.order_id = o.id AND r.deleted_at IS NULL) AS reservations
       FROM "order" o
      WHERE o.display_id = ? AND o.deleted_at IS NULL`,
    [DISPLAY_ID]
  );
  const o = rows[0];
  if (!o) throw new Error(`orden display_id=${DISPLAY_ID} no existe`);
  const meta = (o.metadata ?? {}) as Record<string, unknown>;

  const problems: string[] = [];
  if (meta.is_internal_adjustment !== true) problems.push("no es ajuste interno (metadata.is_internal_adjustment)");
  if (meta.never_sync_to_qb !== true) problems.push("never_sync_to_qb no es true");
  if (o.status !== "pending") problems.push(`status ${String(o.status)} ≠ pending`);
  if (Number(o.invoices) === 0) problems.push("no tiene facturas (nada que haya sido anulado)");
  if (Number(o.active_invoices) > 0) problems.push(`${String(o.active_invoices)} factura(s) ACTIVA(s)`);
  if (Number(o.payments) > 0) problems.push(`${String(o.payments)} pago(s)`);
  if (Number(o.live_fulfillments) > 0) problems.push(`${String(o.live_fulfillments)} fulfillment(s) vivo(s)`);
  if (Number(o.reservations) > 0) problems.push(`${String(o.reservations)} reserva(s) viva(s)`);
  const qbTxn = (meta.qb_sales_order as Record<string, unknown> | undefined)?.txn_id ?? meta.qb_so_txn_id ?? meta.qb_sales_order_txn_id ?? meta.qb_invoice_txn_id;
  if (qbTxn) problems.push(`tiene TxnID de QB en metadata (${String(qbTxn)})`);

  logger.info(`orden ${String(o.id)} (${String(meta.document_number ?? `#${DISPLAY_ID}`)}) · ${String(meta.adjustment_reason ?? "")}`);
  if (problems.length) throw new Error(`guards:\n  - ${problems.join("\n  - ")}`);

  if (!APPLY) {
    logger.info("DRY-RUN: todos los guards pasan; correr con APPLY=true para cancelar");
    return;
  }
  await cancelOrderWorkflow(container).run({ input: { order_id: String(o.id), canceled_by: "cancel-internal-adjustment-order" } });
  const after = await pg.raw(`SELECT status, canceled_at FROM "order" WHERE id = ?`, [o.id]);
  logger.info(`✅ status=${String(after.rows[0]?.status)} canceled_at=${String(after.rows[0]?.canceled_at)}`);
}
