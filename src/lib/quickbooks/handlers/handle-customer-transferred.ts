// 1.5.3: removed direct call to transferDocumentCustomer.
// Handler now only enqueues 'pending' rows; consolidator submits to bridge.
import { getSoTxnId, getLatestInvoiceTxnId } from "../qb-metadata-types";
import { writePipelineRow } from "../qb-pipeline";

import { LOG_PREFIX, isPosOrder } from "./utils";

/**
 * Handles the order.customer_transferred Medusa event.
 *
 * For each QB document tied to the order (Sales Order and/or Invoice),
 * creates a pipeline row and submits the customer-transfer request to the
 * QB bridge asynchronously. The consolidator cron polls for completion and
 * writes the new EditSequence back to order metadata.
 *
 * Scenarios covered:
 *   - SO only             → 1 pipeline row (transfer_customer / sales_order)
 *   - Invoice only        → 1 pipeline row (transfer_customer / invoice)
 *   - SO + Invoice        → 2 pipeline rows (one per document)
 *   - No QB docs          → logged, skipped, no pipeline row
 *   - No customer QB ID   → pipeline row marked failed immediately
 *   - POS order           → skipped (POS handles its own transfer)
 *   - Missing editSeq     → pipeline row marked failed (cannot mod without editSeq)
 */
export async function handleCustomerTransferred(
  data: any,
  orderModule: any,
  logger: any
) {
  const orderId = data.id || data.order_id;
  logger.info(`${LOG_PREFIX} ── order.customer_transferred → ${orderId} ──`);

  let order: any;
  try {
    order = await orderModule.retrieveOrder(orderId, {
      relations: ["customer"],
    });
  } catch (err: any) {
    logger.error(
      `${LOG_PREFIX} ❌ Failed to fetch order ${orderId}: ${err.message}`
    );
    return;
  }

  if (isPosOrder(order)) {
    logger.info(
      `${LOG_PREFIX} ⏭️ POS order — customer transfer handled by POS, skipping`
    );
    return;
  }

  const meta = order.metadata || {};
  const newQbCustomerId = order.customer?.metadata?.qb_list_id as
    | string
    | undefined;

  const soTxnId = getSoTxnId(meta);
  const soEditSeq = (meta.qb_sales_order?.edit_sequence ??
    meta.qb_sales_order_edit_sequence) as string | undefined;
  const invoiceTxnId = getLatestInvoiceTxnId(meta);
  const invEditSeq = (
    Array.isArray(meta.qb_invoices) && meta.qb_invoices.length > 0
      ? meta.qb_invoices[meta.qb_invoices.length - 1]?.edit_sequence
      : meta.qb_invoice_edit_sequence
  ) as string | undefined;

  if (!soTxnId && !invoiceTxnId) {
    logger.info(
      `${LOG_PREFIX} Order ${orderId} has no QB documents — nothing to transfer`
    );
    return;
  }

  if (!newQbCustomerId) {
    logger.warn(
      `${LOG_PREFIX} New customer has no qb_list_id — marking pipeline row(s) failed`
    );
    // Write a failed row so the team can see it in the QB dashboard
    if (soTxnId) {
      await writePipelineRow({
        orderId,
        referenceId: soTxnId,
        referenceType: "sales_order",
        step: "transfer_customer",
        status: "failed",
        error: "New customer has no qb_list_id — cannot transfer SO in QB",
      }).catch(() => {});
    }
    if (invoiceTxnId) {
      await writePipelineRow({
        orderId,
        referenceId: invoiceTxnId,
        referenceType: "invoice",
        step: "transfer_customer",
        status: "failed",
        error: "New customer has no qb_list_id — cannot transfer Invoice in QB",
      }).catch(() => {});
    }
    return;
  }

  // ── Submit each document to the pipeline ──────────────────────────────────

  const docs: Array<{
    docType: "sales-order" | "invoice";
    txnId: string;
    editSeq: string | undefined;
    refType: string;
  }> = [];

  if (soTxnId)
    docs.push({
      docType: "sales-order",
      txnId: soTxnId,
      editSeq: soEditSeq,
      refType: "sales_order",
    });
  if (invoiceTxnId)
    docs.push({
      docType: "invoice",
      txnId: invoiceTxnId,
      editSeq: invEditSeq,
      refType: "invoice",
    });

  for (const doc of docs) {
    // 1.5.3: pre-flight removed — we enqueue once below after editSeq
    // validation, with the full payload the consolidator needs.

    if (!doc.editSeq) {
      const errMsg = `Missing editSequence for ${doc.docType} ${doc.txnId} — cannot transfer without it`;
      logger.warn(`${LOG_PREFIX} ⚠️ ${errMsg}`);
      await writePipelineRow({
        orderId,
        referenceId: doc.txnId,
        referenceType: doc.refType,
        step: "transfer_customer",
        status: "failed",
        error: errMsg,
      }).catch(() => {});
      continue;
    }

    // 1.5.3: enqueue 'pending' row with all data the consolidator needs.
    // The pending-dispatch pass will pick this up next tick, call
    // transferDocumentCustomer, and transition the row to 'submitted' with
    // bridge_op_id. Phase B confirmation writes the new EditSequence back
    // to order metadata (existing logic at lines ~897-952 of consolidator).
    await writePipelineRow({
      orderId,
      referenceId: doc.txnId,
      referenceType: doc.refType,
      step: "transfer_customer",
      status: "pending",
      payload: {
        docType: doc.docType,
        txnId: doc.txnId,
        editSequence: doc.editSeq,
        newCustomerId: newQbCustomerId,
      },
    }).catch((e: any) =>
      logger.warn(
        `${LOG_PREFIX} ⚠️ Could not write pending pipeline row: ${e.message}`
      )
    );

    logger.info(
      `${LOG_PREFIX} 📥 ${doc.docType} ${doc.txnId} enqueued for transfer → consolidator will submit`
    );
  }
}
