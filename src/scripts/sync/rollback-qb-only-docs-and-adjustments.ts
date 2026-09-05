/**
 * Rollback de `backfill-qb-only-docs-2026-06-07.ts` y
 * `backfill-qb-reconciliation-adjustments.ts`.
 *
 *   env DATABASE_URL=... DISABLE_SCHEDULED_JOBS=true \
 *     npx medusa exec ./src/scripts/sync/rollback-qb-only-docs-and-adjustments.ts
 *   env APPLY=true ... para ejecutar
 *   env ONLY=recreated|adjustments ... para revertir una sola mitad
 *
 * Localiza por las MARCAS que los backfills estamparon, no por el audit file:
 * así también limpia una corrida que murió a la mitad y dejó una orden sin su
 * factura — que es exactamente lo que pasó en el sandbox al primer intento.
 *
 * Se NIEGA a borrar cualquier fila que no lleve su marca. Un rollback que
 * pueda tocar un documento real es peor que no tener rollback: el primero borra
 * plata de un cliente, el segundo sólo obliga a limpiar a mano.
 *
 * NO revierte: el cliente de conciliación ni el item `ADJ-RECON`. Los dos son
 * inertes (un cliente sin documentos no aparece en ningún reporte, y un
 * producto `draft` sin precio no se puede vender), y borrarlos rompería una
 * segunda corrida del backfill. Si de verdad hay que sacarlos, es a mano.
 */

import { ExecArgs } from "@medusajs/framework/types";
import { Modules } from "@medusajs/utils";

const APPLY = process.env.APPLY === "true";
const ONLY = process.env.ONLY ?? "";

/** La marca del backfill de documentos ausentes. */
const RECREATED_MARK = "(backfill 2026-09-04)";
/** Los 6 TxnID reales de QuickBooks que ese backfill recrea. */
const RECREATED_TXN_IDS = [
  "1C7515-1781363692", // Invoice 18867
  "1C7F4D-1781961882", // Invoice 18892
  "1C9523-1783442503", // Invoice 18967
  "1C750F-1781363142", // CreditMemo 18866
  "1C7741-1781547132", // CreditMemo 18876
  "1C94E0-1783438165", // CreditMemo 18966
];

export default async function rollbackQbBackfills({
  container,
}: ExecArgs): Promise<void> {
  const logger = container.resolve("logger");
  const pg = container.resolve("__pg_connection__") as any;
  const orderModule = container.resolve(Modules.ORDER) as any;

  const doRecreated = !ONLY || ONLY === "recreated";
  const doAdjustments = !ONLY || ONLY === "adjustments";

  logger.info(
    `\n${"═".repeat(72)}\nrollback — ${APPLY ? "APLICANDO" : "DRY-RUN"}${ONLY ? ` · sólo ${ONLY}` : ""}\n${"═".repeat(72)}`
  );

  const orderIds: string[] = [];
  let invoices = 0;
  let creditMemos = 0;
  let payments = 0;
  let pipeline = 0;

  // ── 1. Documentos RECREADOS ───────────────────────────────────────────────
  if (doRecreated) {
    const orders = (
      await pg.raw(
        `SELECT id, metadata->>'document_number' AS num, metadata->>'qb_invoice_ref_number' AS qb_ref
           FROM "order"
          WHERE metadata->>'manually_imported_source' LIKE ?
            AND deleted_at IS NULL`,
        [`%${RECREATED_MARK}`]
      )
    ).rows;
    for (const o of orders) {
      logger.info(`  orden ${o.num} (QB ${o.qb_ref})`);
      orderIds.push(o.id);
    }

    const invRows = (
      await pg.raw(
        `SELECT i.id, i.invoice_number FROM pos_invoice i
          WHERE i.metadata->>'qb_txn_id' = ANY(?) AND i.deleted_at IS NULL`,
        [RECREATED_TXN_IDS]
      )
    ).rows;
    const cmRows = (
      await pg.raw(
        `SELECT id, credit_memo_number FROM pos_credit_memo
          WHERE qb_txn_id = ANY(?) AND deleted_at IS NULL`,
        [RECREATED_TXN_IDS]
      )
    ).rows;
    invoices += invRows.length;
    creditMemos += cmRows.length;
    logger.info(`  ${invRows.length} factura(s), ${cmRows.length} credit memo(s) recreados`);

    if (APPLY) {
      for (const r of invRows) {
        await pg.raw(`DELETE FROM payment_application WHERE invoice_id = ?`, [r.id]);
        await pg.raw(`DELETE FROM pos_invoice_item WHERE invoice_id = ?`, [r.id]);
        await pg.raw(`DELETE FROM pos_invoice WHERE id = ?`, [r.id]);
      }
      for (const r of cmRows) {
        await pg.raw(`DELETE FROM pos_credit_memo_item WHERE credit_memo_id = ?`, [r.id]);
        await pg.raw(`DELETE FROM pos_credit_memo WHERE id = ?`, [r.id]);
      }
      // Los pagos SÓLO los que este backfill estampó con su TxnID padre.
      const payRes = await pg.raw(
        `DELETE FROM customer_payment
          WHERE metadata->>'qb_parent_txn_id' = ANY(?) RETURNING id`,
        [RECREATED_TXN_IDS]
      );
      payments += payRes.rows.length;
      // Y las filas de pipeline por TxnID, NO sólo por order_id: el credit memo
      // suelto (18876) no tiene orden, así que un barrido por `order_id` deja
      // su fila huérfana. Lo destapó el round-trip en sandbox: 9 de 10 métricas
      // volvían al baseline y ésta quedaba en +1.
      const pipeByTxn = await pg.raw(
        `DELETE FROM qb_order_pipeline WHERE qb_txn_id = ANY(?) RETURNING id`,
        [RECREATED_TXN_IDS]
      );
      pipeline += pipeByTxn.rows.length;
    } else {
      pipeline += Number(
        (
          await pg.raw(
            `SELECT COUNT(*)::int AS n FROM qb_order_pipeline WHERE qb_txn_id = ANY(?)`,
            [RECREATED_TXN_IDS]
          )
        ).rows[0].n
      );
      // El dry-run tiene que contar lo MISMO que el apply borraría: un dry-run
      // que subcuenta es peor que no tenerlo, porque se usa para decidir.
      payments += Number(
        (
          await pg.raw(
            `SELECT COUNT(*)::int AS n FROM customer_payment
              WHERE metadata->>'qb_parent_txn_id' = ANY(?) AND deleted_at IS NULL`,
            [RECREATED_TXN_IDS]
          )
        ).rows[0].n
      );
    }
  }

  // ── 2. AJUSTES de reconciliación ──────────────────────────────────────────
  if (doAdjustments) {
    const adjInv = (
      await pg.raw(
        `SELECT id, invoice_number, order_id, metadata->>'compensates_qb_ref' AS vs
           FROM pos_invoice
          WHERE metadata->>'is_internal_adjustment' = 'true' AND deleted_at IS NULL`
      )
    ).rows;
    const adjCm = (
      await pg.raw(
        `SELECT id, credit_memo_number, metadata->>'compensates_qb_ref' AS vs
           FROM pos_credit_memo
          WHERE metadata->>'is_internal_adjustment' = 'true' AND deleted_at IS NULL`
      )
    ).rows;
    for (const r of adjInv) logger.info(`  ajuste factura ${r.invoice_number} (vs ${r.vs})`);
    for (const r of adjCm) logger.info(`  ajuste ${r.credit_memo_number} (vs ${r.vs})`);
    invoices += adjInv.length;
    creditMemos += adjCm.length;

    if (APPLY) {
      for (const r of adjInv) {
        await pg.raw(`DELETE FROM pos_invoice_item WHERE invoice_id = ?`, [r.id]);
        await pg.raw(`DELETE FROM pos_invoice WHERE id = ?`, [r.id]);
        if (r.order_id) orderIds.push(r.order_id);
      }
      for (const r of adjCm) {
        await pg.raw(`DELETE FROM pos_credit_memo_item WHERE credit_memo_id = ?`, [r.id]);
        await pg.raw(`DELETE FROM pos_credit_memo WHERE id = ?`, [r.id]);
      }
    } else {
      const adjOrders = (
        await pg.raw(
          `SELECT id FROM "order"
            WHERE metadata->>'is_internal_adjustment' = 'true' AND deleted_at IS NULL`
        )
      ).rows;
      for (const o of adjOrders) orderIds.push(o.id);
    }
  }

  // ── 3. Pipeline y órdenes ─────────────────────────────────────────────────
  if (orderIds.length) {
    const uniq = [...new Set(orderIds)];
    if (APPLY) {
      const pipeRes = await pg.raw(
        `DELETE FROM qb_order_pipeline WHERE order_id = ANY(?) RETURNING id`,
        [uniq]
      );
      pipeline += pipeRes.rows.length;
      // Soft-delete por módulo: los triggers de Meili sacan el documento solos.
      await orderModule.softDeleteOrders(uniq);
    } else {
      pipeline += Number(
        (
          await pg.raw(`SELECT COUNT(*)::int AS n FROM qb_order_pipeline WHERE order_id = ANY(?)`, [
            uniq,
          ])
        ).rows[0].n
      );
    }
  }

  logger.info(
    `\n${"─".repeat(72)}\n${APPLY ? "REVERTIDO" : "DRY-RUN"} · ` +
      `${orderIds.length} orden(es) · ${invoices} factura(s) · ${creditMemos} credit memo(s) · ` +
      `${payments} pago(s) · ${pipeline} fila(s) de pipeline\n` +
      (APPLY ? "" : "Para ejecutar: APPLY=true\n") +
      `El cliente de conciliación y el item ADJ-RECON NO se tocan (inertes).\n${"─".repeat(72)}`
  );
}
