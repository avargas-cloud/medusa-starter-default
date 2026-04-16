import { getCachedEditSequence, cacheEditSequence, invalidateEditSequence } from "../qb-pipeline";

import {
  DRY_RUN,
  bridgeFetch,
  pollRawOperationResult,
  pollOperationResult,
} from "./core";
import {
  QbCreateSalesReceiptPayload,
  QbUpdateSalesReceiptPayload,
  QbBridgeResult,
  QbAsyncResult,
} from "./types";

/**
 * Creates a QuickBooks Sales Receipt via the bridge.
 * This is an async bridge operation — poll operationId to confirm txnId.
 */
export async function createSalesReceiptInQb(
  payload: QbCreateSalesReceiptPayload
): Promise<QbBridgeResult<QbAsyncResult>> {
  if (DRY_RUN) {
    console.log(
      `[QB DRY RUN] Would create Sales Receipt for customer ${payload.customerId} (${payload.items.length} items)`
    );
    return { success: true, dryRun: true, data: { operationId: "DRY_RUN" } };
  }

  try {
    const data = await bridgeFetch("POST", "/api/sales-receipts", {
      customerId: payload.customerId,
      refNumber: payload.refNumber,
      date: payload.date,
      PaymentMethod: payload.paymentMethod,
      salesRepRef: payload.salesRep,
      memo: payload.memo,
      salesTaxCode: payload.salesTaxCode,
      items: payload.items.map((item) => ({
        productId: item.productId,
        productName: item.productName,
        quantity: item.quantity,
        price: item.price,
        amount: item.amount,
        desc: item.desc,
      })),
    });

    const operationId = data?.operationId;
    if (!operationId)
      throw new Error(
        "Bridge did not return operationId for Sales Receipt creation"
      );

    console.log(`[QB] Sales Receipt creation queued (op: ${operationId})`);
    return { success: true, data: { operationId } };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Updates an existing Sales Receipt in QuickBooks (salesRep only for now).
 * Fetches EditSequence from cache or QB, then sends SalesReceiptMod.
 */
function isStaleEditSequenceError(msg: string): boolean {
  return /3200|out.of.date|edit.?sequence/i.test(msg);
}

async function fetchFreshEditSequence(txnId: string): Promise<string> {
  const queryResp = await bridgeFetch("GET", `/api/sales-receipts/${txnId}`);
  const queryOpId = queryResp?.operationId;
  if (!queryOpId)
    throw new Error("Bridge did not return operationId for sales receipt query");

  const rawResult = await pollRawOperationResult(queryOpId);
  const srRet =
    rawResult?.QBXML?.QBXMLMsgsRs?.SalesReceiptQueryRs?.SalesReceiptRet ??
    rawResult?.QBXMLMsgsRs?.SalesReceiptQueryRs?.SalesReceiptRet ??
    rawResult?.SalesReceiptRet ??
    rawResult?.SalesReceiptQueryRs?.SalesReceiptRet;

  if (!srRet?.EditSequence)
    throw new Error("Could not extract EditSequence from sales receipt query result");

  return srRet.EditSequence as string;
}

export async function updateSalesReceiptInQb(
  payload: QbUpdateSalesReceiptPayload
): Promise<QbBridgeResult<QbAsyncResult>> {
  if (DRY_RUN) {
    console.log(`[QB DRY RUN] Would update Sales Receipt ${payload.txnId}`);
    return {
      success: true,
      dryRun: true,
      data: { operationId: "DRY_RUN", txnId: payload.txnId },
    };
  }

  const sendMod = async (editSequence: string) => {
    const modResp = await bridgeFetch(
      "PUT",
      `/api/sales-receipts/${payload.txnId}`,
      {
        EditSequence: editSequence,
        ...(payload.salesRep ? { salesRepRef: payload.salesRep } : {}),
        ...(payload.salesTaxCode ? { salesTaxCode: payload.salesTaxCode } : {}),
        ...(payload.taxExempt === true ? { taxExempt: true } : {}),
      }
    );
    const operationId = modResp?.operationId;
    if (!operationId)
      throw new Error("Bridge did not return operationId for sales receipt update (mod)");
    return operationId;
  };

  try {
    // ── Step 1: get EditSequence (cache or QB query) ──────────────────────
    let editSequence: string;
    const cached = await getCachedEditSequence("sales_receipt", payload.txnId);
    if (cached?.editSeq) {
      console.log(`[QB] ✅ Cache hit for sales receipt ${payload.txnId} — skipping GET round-trip`);
      editSequence = cached.editSeq;
    } else {
      console.log(`[QB] Cache miss for sales receipt ${payload.txnId} — querying QB for EditSequence`);
      editSequence = await fetchFreshEditSequence(payload.txnId);
      cacheEditSequence("sales_receipt", payload.txnId, editSequence).catch(() => {});
    }

    // ── Step 2: send mod and poll ─────────────────────────────────────────
    let operationId = await sendMod(editSequence);
    console.log(`[QB] Sales Receipt mod queued. OperationID: ${operationId}`);

    let pollResult: QbAsyncResult;
    try {
      pollResult = await pollOperationResult(operationId);
    } catch (pollErr: any) {
      // ── Step 3: stale EditSequence → invalidate, re-fetch, retry once ───
      if (isStaleEditSequenceError(pollErr.message)) {
        console.warn(
          `[QB] ⚠️ Stale EditSequence for SR ${payload.txnId} (${editSequence}) — invalidating cache and retrying`
        );
        await invalidateEditSequence("sales_receipt", payload.txnId);

        const freshEditSeq = await fetchFreshEditSequence(payload.txnId);
        cacheEditSequence("sales_receipt", payload.txnId, freshEditSeq).catch(() => {});

        operationId = await sendMod(freshEditSeq);
        console.log(`[QB] Sales Receipt mod retry queued. OperationID: ${operationId}`);
        pollResult = await pollOperationResult(operationId);
      } else {
        throw pollErr;
      }
    }

    if (pollResult.editSequence) {
      cacheEditSequence("sales_receipt", payload.txnId, pollResult.editSequence).catch(() => {});
    }

    console.log(`[QB] ✅ Sales Receipt updated. OperationID: ${operationId}`);
    return { success: true, data: { operationId, txnId: payload.txnId } };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Voids a Sales Receipt in QuickBooks.
 * Fetches the EditSequence dynamically before voiding to ensure consistency.
 */
export async function voidSalesReceiptInQb(
  receiptTxnId: string,
  log: (msg: string) => void = console.log
): Promise<QbBridgeResult<QbAsyncResult>> {
  if (DRY_RUN) {
    log(`[QB DRY RUN] Would void Sales Receipt ${receiptTxnId}`);
    return {
      success: true,
      dryRun: true,
      data: { operationId: "DRY_RUN", txnId: receiptTxnId },
    };
  }

  try {
    log(
      `[QB] Querying Sales Receipt ${receiptTxnId} to get EditSequence for voiding...`
    );
    const queryResp = await bridgeFetch(
      "GET",
      `/api/sales-receipts/${receiptTxnId}`
    );
    const queryOpId = queryResp?.operationId;
    if (!queryOpId)
      throw new Error(
        "Bridge did not return operationId for Sales Receipt query"
      );

    const rawResult = await pollRawOperationResult(queryOpId);

    const receiptRet =
      rawResult?.QBXML?.QBXMLMsgsRs?.SalesReceiptQueryRs?.SalesReceiptRet ??
      rawResult?.QBXMLMsgsRs?.SalesReceiptQueryRs?.SalesReceiptRet ??
      rawResult?.SalesReceiptRet ??
      rawResult?.SalesReceiptQueryRs?.SalesReceiptRet;

    const editSequence = receiptRet?.EditSequence as string | undefined;
    if (!editSequence) {
      log(
        `[QB] Warning: Could not extract EditSequence for Sales Receipt ${receiptTxnId}. Proceeding with void.`
      );
    } else {
      log(
        `[QB] EditSequence obtained: ${editSequence}. Voiding Sales Receipt...`
      );
    }

    const data = await bridgeFetch(
      "DELETE",
      `/api/sales-receipts/${receiptTxnId}`
    );
    const operationId = data?.operationId;
    if (!operationId)
      throw new Error(
        "Bridge did not return operationId for Sales Receipt void"
      );

    log(`[QB] Sales Receipt ${receiptTxnId} void queued (op: ${operationId})`);
    const result = await pollOperationResult(operationId, log);
    return { success: true, data: result };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}
