import {
  writePipelineRow,
  findLastInFlightSoToggleRow,
} from "../../../../../../lib/quickbooks/qb-pipeline";

const LOG_PREFIX = "[toggle-close/qb]";

export interface QbToggleResult {
  qbSkipped: boolean;
  qbError?: string;
}

/**
 * Enqueue a QB Sales Order toggle (so_close / so_reopen) for the order.
 *
 * Reads the SO TxnID from order metadata; if none exists the toggle is skipped.
 * In-flight so_close/so_reopen rows are chained via depends_on so they never race
 * in QB. Mirrors the original inline logic from toggle-close/route.ts (1.5.5:
 * pipeline-only — the consolidator submits to the bridge).
 */
export async function enqueueSoToggle(opts: {
  orderId: string;
  meta: Record<string, any>;
  action: "close" | "reopen";
}): Promise<QbToggleResult> {
  const { orderId, meta, action } = opts;

  const soTxnId: string | undefined =
    (meta.qb_sales_order as any)?.txn_id ||
    meta.qb_so_txn_id ||
    meta.qb_sales_order_txn_id;

  const soRefNumber: string | undefined =
    (meta.qb_sales_order as any)?.ref_number ||
    (meta.qb_so_ref_number as string | undefined);

  const medusaRefNumber = meta.document_number
    ? String(meta.document_number)
    : null;
  const pipelineStep = action === "close" ? "so_close" : "so_reopen";

  if (!soTxnId) {
    console.log(`${LOG_PREFIX} No QB SO TxnID — skipping QB ${action}`);
    // Still record a skipped row for auditability.
    try {
      await writePipelineRow({
        orderId,
        referenceId: orderId,
        referenceType: "order",
        step: pipelineStep,
        status: "skipped",
        qbTxnId: null,
        qbRefNumber: soRefNumber ?? null,
        medusaRefNumber,
      });
    } catch {}
    return { qbSkipped: true };
  }

  // Chain behind any in-flight so_close/so_reopen row so they run sequentially.
  let dependsOnRowId: string | null = null;
  try {
    dependsOnRowId = await findLastInFlightSoToggleRow(orderId);
  } catch (depErr: any) {
    console.warn(
      `${LOG_PREFIX} Could not check in-flight rows: ${depErr.message}`
    );
  }

  if (dependsOnRowId) {
    try {
      await writePipelineRow({
        orderId,
        referenceId: orderId,
        referenceType: "order",
        step: pipelineStep,
        status: "waiting",
        dependsOn: dependsOnRowId,
        qbTxnId: soTxnId,
        qbRefNumber: soRefNumber ?? null,
        medusaRefNumber,
      });
      console.log(
        `${LOG_PREFIX} ⛓️ Chained ${action} behind ${dependsOnRowId} (waiting)`
      );
    } catch (qbErr: any) {
      console.warn(`${LOG_PREFIX} Enqueue (waiting) exception: ${qbErr.message}`);
      return { qbSkipped: true, qbError: qbErr.message };
    }
    // Deferred until the dependency resolves.
    return { qbSkipped: true };
  }

  try {
    await writePipelineRow({
      orderId,
      referenceId: orderId,
      referenceType: "order",
      step: pipelineStep,
      status: "pending",
      qbTxnId: soTxnId,
      qbRefNumber: soRefNumber ?? null,
      medusaRefNumber,
    });
    console.log(
      `${LOG_PREFIX} 📥 Enqueued ${action} for SO ${soTxnId} (consolidator will submit)`
    );
    return { qbSkipped: false };
  } catch (qbErr: any) {
    console.warn(`${LOG_PREFIX} Enqueue exception: ${qbErr.message}`);
    return { qbSkipped: true, qbError: qbErr.message };
  }
}
