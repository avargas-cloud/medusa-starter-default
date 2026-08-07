import type { MedusaRequest, MedusaResponse } from "@medusajs/framework";

import { updateInvoiceInQb } from "../../../../../lib/quickbooks/client/invoices";
import { updateSalesReceiptInQb } from "../../../../../lib/quickbooks/client/sales-receipts";
import {
  confirmPipelineRow,
  enqueueSalesMutation,
  failPipelineRow,
  submitPipelineRowById,
} from "../../../../../lib/quickbooks/qb-pipeline";
import { INVOICE_MODULE } from "../../../../../modules/invoices";

/**
 * POST /admin/invoices/:id/sync-qb-rep
 *
 * Updates the Sales Rep on the corresponding QB document (Invoice or SalesReceipt)
 * after a rep change is saved to Medusa.
 *
 * Body: { salesRep: string }  — QB initials (e.g. "AG")
 */
export async function POST(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const { id } = req.params as { id: string };
  const { salesRep } = (req.body ?? {}) as { salesRep?: string };

  if (!salesRep?.trim()) {
    res.status(400).json({ error: "salesRep is required" });
    return;
  }

  if (process.env.QB_ORDER_FLOW_ENABLED !== "true") {
    res.json({
      success: true,
      skipped: true,
      reason: "QB integration disabled",
    });
    return;
  }

  const invoiceService = req.scope.resolve(INVOICE_MODULE);
  const [invoice] = await invoiceService
    .listPosInvoices({ id: [id] })
    .catch(() => []);

  if (!invoice) {
    res.status(404).json({ error: `Invoice ${id} not found` });
    return;
  }

  const meta: Record<string, unknown> = (invoice as any).metadata ?? {};
  const txnId = (meta.qb_invoice_txn_id ?? meta.qb_txn_id) as
    | string
    | undefined;
  // Support both the new canonical field and the legacy field name
  const isSalesReceipt = !!(meta.qb_is_sales_receipt ?? meta.is_sales_receipt);

  if (!txnId) {
    res
      .status(422)
      .json({ error: "Invoice has no QB TxnID — cannot sync rep" });
    return;
  }

  const invoiceRef = (invoice as any).invoice_number
    ? `INV-${(invoice as any).invoice_number}`
    : null;

  // Append-only lane: own row for this rep MOD, transitioned by row id. The
  // step matches the DOCUMENT QB actually holds — registering a
  // SalesReceiptMod as `invoice_update` sent the EditSequence heal to the
  // Invoice endpoint for SRs (Fase 1 finding, 2026-08-06).
  const modStep = isSalesReceipt ? "sales_receipt_update" : "invoice_update";
  let rowId: string | null = null;
  try {
    const enqueued = await enqueueSalesMutation({
      orderId: (invoice as any).order_id ?? null,
      referenceId: id,
      referenceType: "pos_invoice",
      step: modStep,
      qbTxnId: txnId,
      payload: { salesRep: salesRep.trim() },
      mergePayload: true,
      medusaRefNumber: invoiceRef,
    });
    rowId = enqueued.rowId;
  } catch {
    /* bookkeeping only — the MOD itself proceeds */
  }

  const updateFn = isSalesReceipt ? updateSalesReceiptInQb : updateInvoiceInQb;
  const result = await updateFn({ txnId, salesRep: salesRep.trim() });

  if (!result.success) {
    if (rowId) {
      failPipelineRow(rowId, result.error ?? "QB update failed").catch(
        () => {}
      );
    }
    res.status(502).json({ error: result.error ?? "QB update failed" });
    return;
  }

  if (rowId) {
    submitPipelineRowById(rowId, result.data?.operationId ?? null)
      .then(() => confirmPipelineRow(rowId!, txnId, null, null))
      .catch(() => {});
  }

  res.json({
    success: true,
    operationId: result.data?.operationId,
    isSalesReceipt,
  });
}
