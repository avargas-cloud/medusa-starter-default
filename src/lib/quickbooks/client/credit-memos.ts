import {
  getCachedEditSequence,
  cacheEditSequence,
  invalidateEditSequence,
} from "../qb-pipeline";

import {
  DRY_RUN,
  bridgeFetch,
  pollRawOperationResult,
  pollOperationResult,
} from "./core";
import {
  QbCreateCreditMemoPayload,
  QbUpdateCreditMemoPayload,
  QbBridgeResult,
  QbAsyncResult,
} from "./types";

/**
 * Creates a Credit Memo in QuickBooks (async).
 */
export async function createCreditMemoInQb(
  payload: QbCreateCreditMemoPayload
): Promise<QbBridgeResult<QbAsyncResult>> {
  if (DRY_RUN) {
    console.log(
      `[QB DRY RUN] Would create Credit Memo in QB for customer ${payload.customerId}`
    );
    return {
      success: true,
      dryRun: true,
      data: {
        operationId: "DRY_RUN",
        txnId: "DRY_RUN_CREDIT_MEMO_TXNID",
        refNumber: "DRY_RUN_REF",
      },
    };
  }

  try {
    const { refNumber: _refNumber, ...body } = payload;
    const data = await bridgeFetch("POST", "/api/credit-memos", body);
    const operationId = data?.operationId;
    if (!operationId)
      throw new Error("Bridge did not return an operationId for Credit Memo");
    return { success: true, data: { operationId } };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Updates an existing Credit Memo in QuickBooks (salesRep, tax, memo).
 * Uses cached EditSequence when available; falls back to the value provided by the caller.
 * On 3200 (stale EditSequence), invalidates cache and retries once.
 */
export async function updateCreditMemoInQb(
  payload: QbUpdateCreditMemoPayload
): Promise<QbBridgeResult<QbAsyncResult>> {
  if (DRY_RUN) {
    console.log(`[QB DRY RUN] Would update Credit Memo ${payload.txnId}`);
    return {
      success: true,
      dryRun: true,
      data: { operationId: "DRY_RUN", txnId: payload.txnId },
    };
  }

  const sendMod = async (editSequence: string) => {
    const modResp = await bridgeFetch(
      "PUT",
      `/api/credit-memos/${payload.txnId}`,
      {
        EditSequence: editSequence,
        ...(payload.salesRepRef ? { salesRepRef: payload.salesRepRef } : {}),
        ...(payload.salesTaxCode ? { salesTaxCode: payload.salesTaxCode } : {}),
        ...(payload.qbTaxItemListid
          ? { qbTaxItemListid: payload.qbTaxItemListid }
          : {}),
        ...(payload.taxExempt === true ? { taxExempt: true } : {}),
        ...(payload.memo !== undefined ? { memo: payload.memo } : {}),
        ...(payload.customerId ? { customerId: payload.customerId } : {}),
        ...(payload.date ? { date: payload.date } : {}),
        ...(payload.items && payload.items.length > 0
          ? { items: payload.items }
          : {}),
        ...(payload.qbLineOrder && payload.qbLineOrder.length > 0
          ? { qbLineOrder: payload.qbLineOrder }
          : {}),
      }
    );
    const operationId = modResp?.operationId;
    if (!operationId)
      throw new Error("Bridge did not return operationId for credit memo mod");
    return operationId;
  };

  try {
    let editSequence: string;
    const cached = await getCachedEditSequence("credit_memo", payload.txnId);
    if (cached?.editSeq) {
      console.log(
        `[QB] ✅ Cache hit for credit memo ${payload.txnId} — skipping GET`
      );
      editSequence = cached.editSeq;
    } else {
      console.log(
        `[QB] Cache miss for credit memo ${payload.txnId} — using stored EditSequence`
      );
      editSequence = payload.editSequence;
      if (!editSequence)
        throw new Error(
          `No EditSequence available for credit memo ${payload.txnId}. Sync the CM first.`
        );
      cacheEditSequence("credit_memo", payload.txnId, editSequence).catch(
        () => {}
      );
    }

    try {
      const operationId = await sendMod(editSequence);
      return { success: true, data: { operationId, txnId: payload.txnId } };
    } catch (firstErr: any) {
      if (firstErr.message?.includes("3200")) {
        console.log(
          `[QB] EditSequence stale for credit memo ${payload.txnId} — invalidating cache and retrying`
        );
        await invalidateEditSequence("credit_memo", payload.txnId);
        throw new Error(
          `EditSequence stale for credit memo ${payload.txnId}. Retry or re-complete the CM.`
        );
      }
      throw firstErr;
    }
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Voids a Credit Memo in QuickBooks by TxnID.
 * Fetches EditSequence first if not provided.
 */
export async function voidCreditMemoInQb(
  txnId: string,
  editSequence?: string | null,
  log: (msg: string) => void = console.log
): Promise<QbBridgeResult<QbAsyncResult>> {
  if (DRY_RUN) {
    log(`[QB DRY RUN] Would void Credit Memo ${txnId}`);
    return {
      success: true,
      dryRun: true,
      data: { operationId: "DRY_RUN", txnId },
    };
  }

  try {
    // Fetch EditSequence if not already known
    let resolvedEditSeq = editSequence;
    if (!resolvedEditSeq) {
      log(`[QB] Fetching Credit Memo ${txnId} to get EditSequence...`);
      const queryResp = await bridgeFetch("GET", `/api/credit-memos/${txnId}`);
      const queryOpId = queryResp?.operationId;
      if (queryOpId) {
        const rawResult = await pollRawOperationResult(queryOpId, log);
        const cmRet =
          rawResult?.QBXML?.QBXMLMsgsRs?.CreditMemoQueryRs?.CreditMemoRet ??
          rawResult?.QBXMLMsgsRs?.CreditMemoQueryRs?.CreditMemoRet ??
          rawResult?.CreditMemoRet;
        resolvedEditSeq = cmRet?.EditSequence as string | undefined;
        if (resolvedEditSeq)
          log(`[QB] EditSequence obtained: ${resolvedEditSeq}`);
      }
    }

    if (!resolvedEditSeq) {
      log(
        `[QB] Warning: Could not obtain EditSequence for Credit Memo ${txnId}. Proceeding anyway.`
      );
    }

    const data = await bridgeFetch("DELETE", `/api/credit-memos/${txnId}`);
    const operationId = data?.operationId;
    if (!operationId)
      throw new Error("Bridge did not return operationId for Credit Memo void");

    log(`[QB] Credit Memo ${txnId} void queued (op: ${operationId})`);
    const result = await pollOperationResult(operationId, log);
    return { success: true, data: result };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}
