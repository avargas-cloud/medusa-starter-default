import { getCachedEditSequence, cacheEditSequence } from "../qb-pipeline";

import {
  DRY_RUN,
  bridgeFetch,
  pollRawOperationResult,
  pollOperationResult,
} from "./core";
import {
  QbCreateInvoicePayload,
  QbUpdateInvoicePayload,
  QbBridgeResult,
  QbAsyncResult,
} from "./types";

/**
 * Creates an Invoice in QuickBooks (async).
 * Can be linked to a Sales Order via LinkToTxnID, or standalone with items[].
 */
export async function createInvoiceInQb(
  payload: QbCreateInvoicePayload
): Promise<QbBridgeResult<QbAsyncResult>> {
  if (DRY_RUN) {
    console.log(
      `[QB DRY RUN] Would create Invoice in QB linked to SO:`,
      payload.LinkToTxnID || "(standalone)"
    );
    return {
      success: true,
      dryRun: true,
      data: {
        operationId: "DRY_RUN",
        txnId: "DRY_RUN_INVOICE_TXNID",
        refNumber: "DRY_RUN_REF",
      },
    };
  }

  try {
    const body = {
      ...payload,
      templateRef: payload.templateRef || "Invoice Ecopowertech",
      salesRepRef: payload.salesRep,
    };
    const data = await bridgeFetch("POST", "/api/invoices", body);
    const operationId = data?.operationId;
    if (!operationId)
      throw new Error("Bridge did not return an operationId for Invoice");
    return { success: true, data: { operationId } };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Updates an existing Invoice in QuickBooks (salesRep only for now).
 * Fetches EditSequence from cache or QB, then sends InvoiceMod.
 */
export async function updateInvoiceInQb(
  payload: QbUpdateInvoicePayload
): Promise<QbBridgeResult<QbAsyncResult>> {
  if (DRY_RUN) {
    console.log(`[QB DRY RUN] Would update Invoice ${payload.txnId}`);
    return {
      success: true,
      dryRun: true,
      data: { operationId: "DRY_RUN", txnId: payload.txnId },
    };
  }

  try {
    let editSequence: string;

    const cached = await getCachedEditSequence("invoice", payload.txnId);
    if (cached?.editSeq) {
      console.log(
        `[QB] ✅ Cache hit for invoice ${payload.txnId} — skipping GET round-trip`
      );
      editSequence = cached.editSeq;
    } else {
      console.log(
        `[QB] Cache miss for invoice ${payload.txnId} — querying QB for EditSequence`
      );
      const queryResp = await bridgeFetch(
        "GET",
        `/api/invoices/${payload.txnId}`
      );
      const queryOpId = queryResp?.operationId;
      if (!queryOpId)
        throw new Error("Bridge did not return operationId for invoice query");

      const rawResult = await pollRawOperationResult(queryOpId);
      const invRet =
        rawResult?.QBXML?.QBXMLMsgsRs?.InvoiceQueryRs?.InvoiceRet ??
        rawResult?.QBXMLMsgsRs?.InvoiceQueryRs?.InvoiceRet ??
        rawResult?.InvoiceRet ??
        rawResult?.InvoiceQueryRs?.InvoiceRet;

      if (!invRet?.EditSequence) {
        throw new Error(
          `Could not extract EditSequence from invoice query result`
        );
      }
      editSequence = invRet.EditSequence as string;
      cacheEditSequence("invoice", payload.txnId, editSequence).catch(() => {});
    }

    const modResp = await bridgeFetch("PUT", `/api/invoices/${payload.txnId}`, {
      EditSequence: editSequence,
      ...(payload.salesRep ? { salesRepRef: payload.salesRep } : {}),
    });

    const operationId = modResp?.operationId;
    if (!operationId)
      throw new Error(
        "Bridge did not return operationId for invoice update (mod)"
      );

    console.log(`[QB] ✅ Invoice update queued. OperationID: ${operationId}`);
    return { success: true, data: { operationId, txnId: payload.txnId } };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Voids an Invoice in QuickBooks.
 * Fetches the EditSequence dynamically before voiding to ensure consistency.
 */
export async function voidInvoiceInQb(
  invoiceTxnId: string,
  log: (msg: string) => void = console.log
): Promise<QbBridgeResult<QbAsyncResult>> {
  if (DRY_RUN) {
    log(`[QB DRY RUN] Would void Invoice ${invoiceTxnId}`);
    return {
      success: true,
      dryRun: true,
      data: { operationId: "DRY_RUN", txnId: invoiceTxnId },
    };
  }

  try {
    log(
      `[QB] Querying Invoice ${invoiceTxnId} to get EditSequence for voiding...`
    );
    const queryResp = await bridgeFetch("GET", `/api/invoices/${invoiceTxnId}`);
    const queryOpId = queryResp?.operationId;
    if (!queryOpId)
      throw new Error("Bridge did not return operationId for Invoice query");

    const rawResult = await pollRawOperationResult(queryOpId, log);

    const invRet =
      rawResult?.QBXML?.QBXMLMsgsRs?.InvoiceQueryRs?.InvoiceRet ??
      rawResult?.QBXMLMsgsRs?.InvoiceQueryRs?.InvoiceRet ??
      rawResult?.InvoiceRet ??
      rawResult?.InvoiceQueryRs?.InvoiceRet;

    const editSequence = invRet?.EditSequence as string | undefined;
    // Warning if missing, though TxnVoidRq technically doesn't require it, we fetch it per policy.
    if (!editSequence) {
      log(
        `[QB] Warning: Could not extract EditSequence for Invoice ${invoiceTxnId}. Proceeding with void.`
      );
    } else {
      log(`[QB] EditSequence obtained: ${editSequence}. Voiding Invoice...`);
    }

    const data = await bridgeFetch("DELETE", `/api/invoices/${invoiceTxnId}`);
    const operationId = data?.operationId;
    if (!operationId)
      throw new Error("Bridge did not return operationId for Invoice void");

    log(`[QB] Invoice ${invoiceTxnId} void queued (op: ${operationId})`);
    const result = await pollOperationResult(operationId, log);
    return { success: true, data: result };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}
